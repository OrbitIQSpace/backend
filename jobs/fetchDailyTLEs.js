// backend/jobs/fetchDailyTLEs.js — FINAL, WORKING WITH MULTI-TENANCY
import axios from 'axios';
import { pool } from '../index.js';

const USERNAME = process.env.SPACETRACK_USER;
const PASSWORD = process.env.SPACETRACK_PASS;

const EARTH_RADIUS_KM = 6378.137;
const GM_KM3_S2 = 398600.4418;

let cookies = null;

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const login = async () => {
  try {
    const res = await axios.post(
      'https://www.space-track.org/ajaxauth/login',
      `identity=${USERNAME}&password=${PASSWORD}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    cookies = res.headers['set-cookie'];
    console.log('✅ Space-Track login successful');
    return true;
  } catch (err) {
    console.error('❌ Login failed:', err.response?.data || err.message);
    cookies = null;
    return false;
  }
};

const calculateDerived = (line1, line2) => {
  if (!line1 || !line2) return null;

  const meanMotion = parseFloat(line2.slice(52, 63));
  if (!meanMotion) return null;

  const periodSec = 86400 / meanMotion;
  const periodMin = periodSec / 60;
  const semiMajorAxis = Math.cbrt(GM_KM3_S2 * Math.pow(periodSec / (2 * Math.PI), 2));
  const inclination = parseFloat(line2.slice(8, 16));
  const eccentricity = parseFloat('0.' + line2.slice(26, 33));
  const raan = parseFloat(line2.slice(17, 25));
  const argPerigee = parseFloat(line2.slice(34, 42));
  const meanAnomaly = parseFloat(line2.slice(43, 51));

  const altitude = semiMajorAxis - EARTH_RADIUS_KM;
  const velocity = (2 * Math.PI * semiMajorAxis) / periodSec;
  const perigee = (semiMajorAxis * (1 - eccentricity)) - EARTH_RADIUS_KM;
  const apogee = (semiMajorAxis * (1 + eccentricity)) - EARTH_RADIUS_KM;

  const bstarStr = line1.slice(53, 63).trim();
  const bstar = bstarStr ? parseFloat(bstarStr.replace('+', 'e+').replace('-', 'e-')) : 0;
  const mmDotStr = line1.slice(33, 43).trim();
  const mean_motion_dot = mmDotStr ? parseFloat(mmDotStr) : 0;
  const mmDdotStr = line1.slice(44, 52).trim();
  const mean_motion_ddot = mmDdotStr ? parseFloat(mmDdotStr) : 0;

  return {
    inclination: parseFloat(inclination.toFixed(4)),
    eccentricity: parseFloat(eccentricity.toFixed(8)),
    mean_motion: parseFloat(meanMotion.toFixed(8)),
    semi_major_axis_km: parseFloat(semiMajorAxis.toFixed(4)),
    perigee_km: parseFloat(perigee.toFixed(2)),
    apogee_km: parseFloat(apogee.toFixed(2)),
    orbital_period_minutes: parseFloat(periodMin.toFixed(4)),
    altitude_km: parseFloat(altitude.toFixed(2)),
    velocity_kms: parseFloat(velocity.toFixed(4)),
    raan: parseFloat(raan.toFixed(4)),
    arg_perigee: parseFloat(argPerigee.toFixed(4)),
    mean_anomaly: parseFloat(meanAnomaly.toFixed(4)),
    bstar,
    mean_motion_dot,
    mean_motion_ddot,
  };
};

const fetchAndStoreTLEs = async (retryCount = 0) => {
  if (!cookies && !(await login())) {
    console.log('Skipping TLE fetch — no session');
    return;
  }

  try {
    const { rows } = await pool.query(`
      SELECT norad_id, user_id 
      FROM satellites 
      WHERE norad_id IS NOT NULL AND user_id IS NOT NULL
    `);
    if (rows.length === 0) return console.log('⚠️ No satellites with user_id in DB to update');

    const noradList = rows.map(r => r.norad_id).join(',');
    const userMap = {};
    rows.forEach(r => userMap[r.norad_id] = r.user_id);

    const url = `https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/${noradList}/orderby/EPOCH%20desc/format/tle`;

    console.log(`📡 Fetching TLEs for ${rows.length} satellites...`);

    const response = await axios.get(url, {
      headers: { Cookie: cookies.join('; ') },
      timeout: 30000,
    });

    const lines = response.data.trim().split('\n').map(l => l.trim()).filter(Boolean);
    let storedCount = 0;
    let i = 0;

    while (i < lines.length) {
      let name = 'UNKNOWN';
      let line1 = lines[i];
      let line2 = lines[i + 1];

      if (line1 && !line1.startsWith('1 ')) {
        name = line1;
        line1 = lines[i + 1];
        line2 = lines[i + 2];
        i += 3;
      } else {
        line2 = lines[i + 1];
        i += 2;
      }

      if (!line1 || !line2 || !line1.startsWith('1 ') || !line2.startsWith('2 ')) {
        console.warn('Skipping invalid TLE block');
        continue;
      }

      const norad = line1.slice(2, 7).trim();
      const userId = userMap[norad];

      if (!userId) {
        console.warn(`No user_id found for NORAD ${norad} — skipping`);
        continue;
      }

      const year = parseInt(line1.slice(18, 20));
      const dayOfYear = parseFloat(line1.slice(20, 32));
      const fullYear = year < 57 ? 2000 + year : 1900 + year;
      const epochDate = new Date(Date.UTC(fullYear, 0));
      epochDate.setUTCDate(epochDate.getUTCDate() + dayOfYear - 1);
      const fraction = dayOfYear % 1;
      epochDate.setSeconds(epochDate.getSeconds() + (fraction * 86400));

      const derived = calculateDerived(line1, line2);
      if (!derived) continue;

      // tle_history — ON CONFLICT (norad_id, epoch, user_id)
      await pool.query(`
        INSERT INTO tle_history (norad_id, name, tle_line1, tle_line2, epoch, user_id)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (norad_id, epoch, user_id) DO NOTHING
      `, [norad, name, line1, line2, epochDate, userId]);

      // tle_derived — ON CONFLICT (norad_id, epoch, user_id)
      await pool.query(`
        INSERT INTO tle_derived (
          norad_id, name, epoch,
          inclination, eccentricity, mean_motion,
          semi_major_axis_km, perigee_km, apogee_km,
          orbital_period_minutes, altitude_km, velocity_kms,
          raan, arg_perigee, mean_anomaly,
          bstar, mean_motion_dot, mean_motion_ddot,
          user_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19
        )
        ON CONFLICT (norad_id, epoch, user_id) DO NOTHING
      `, [
        norad, name, epochDate,
        derived.inclination, derived.eccentricity, derived.mean_motion,
        derived.semi_major_axis_km, derived.perigee_km, derived.apogee_km,
        derived.orbital_period_minutes, derived.altitude_km, derived.velocity_kms,
        derived.raan, derived.arg_perigee, derived.mean_anomaly,
        derived.bstar, derived.mean_motion_dot, derived.mean_motion_ddot,
        userId
      ]);

      storedCount++;
    }

    console.log(`✅ Successfully processed TLEs. Stored/Checked: ${storedCount}`);
  } catch (err) {
    console.error(`❌ TLE fetch attempt ${retryCount + 1} failed:`, err.message);

    if (retryCount < 3) {
      console.log(`⏳ Retrying in 30 seconds...`);
      cookies = null;
      await sleep(30000);
      return fetchAndStoreTLEs(retryCount + 1);
    } else {
      console.error('🚫 Giving up after 3 failed attempts.');
    }
  }
};

const runForever = async () => {
  console.log('🚀 OrbitIQ TLE fetch job STARTED — running every 12 hours');
  await fetchAndStoreTLEs();

  setInterval(async () => {
    console.log('⏰ 12h TLE fetch triggered:', new Date().toISOString());
    await fetchAndStoreTLEs();
  }, 12 * 60 * 60 * 1000);
};

runForever();