// backend/jobs/fetchDailyTLEs.js — CRON JOB ONLY (runs once and exits)
import axios from 'axios';
import { Pool } from 'pg';
import { populateDerived } from '../scripts/populatedDerived.js';

// Database connection — separate from web server
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false,
});

const USERNAME = process.env.SPACETRACK_USER;
const PASSWORD = process.env.SPACETRACK_PASS;

let cookies = null;
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const loginToSpaceTrack = async () => {
  if (!USERNAME || !PASSWORD) {
    console.error('SPACETRACK_USER or SPACETRACK_PASS missing');
    return false;
  }

  try {
    const resp = await axios.post(
      'https://www.space-track.org/ajaxauth/login',
      `identity=${encodeURIComponent(USERNAME)}&password=${encodeURIComponent(PASSWORD)}`,
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    cookies = resp.headers['set-cookie'];
    console.log('✅ Space-Track login successful');
    return true;
  } catch (err) {
    console.error('❌ Space-Track login failed:', err.response?.data || err.message);
    cookies = null;
    return false;
  }
};

const fetchAndStoreTLEs = async () => {
  console.log('🚀 TLE fetch job started:', new Date().toISOString());

  if (!cookies && !(await loginToSpaceTrack())) {
    console.log('Skipping fetch — no session');
    return;
  }

  try {
    const { rows } = await pool.query(`
      SELECT norad_id, user_id
      FROM satellites
      WHERE norad_id IS NOT NULL AND user_id IS NOT NULL
    `);

    if (rows.length === 0) {
      console.log('⚠️ No satellites to update');
      return;
    }

    console.log(`📡 Updating TLEs for ${rows.length} satellites...`);

    let storedCount = 0;

    for (const { norad_id: norad, user_id: userId } of rows) {
      try {
        const url = `https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/${norad}/orderby/EPOCH%20desc/format/3le/limit/1`;

        const response = await axios.get(url, {
          headers: { Cookie: cookies.join('; ') },
          timeout: 15000,
        });

        const data = response.data.trim();
        if (!data || data.length < 50) {
          console.warn(`No valid TLE for NORAD ${norad}`);
          continue;
        }

        const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
        if (lines.length < 3) {
          console.warn(`Invalid 3le format for NORAD ${norad}`);
          continue;
        }

        const name = lines[0];
        const line1 = lines[1];
        const line2 = lines[2];

        // Parse epoch
        const year = parseInt(line1.slice(18, 20));
        const dayOfYear = parseFloat(line1.slice(20, 32));
        const fullYear = year < 57 ? 2000 + year : 1900 + year;
        const epochDate = new Date(Date.UTC(fullYear, 0));
        epochDate.setUTCDate(epochDate.getUTCDate() + Math.floor(dayOfYear) - 1);
        const millisecondsInDay = (dayOfYear % 1) * 86400000;
        epochDate.setMilliseconds(epochDate.getMilliseconds() + millisecondsInDay);

        const derived = populateDerived(line1, line2);
        if (!derived) {
          console.warn(`Failed to derive params for NORAD ${norad}`);
          continue;
        }

        // Insert into tle_history
        await pool.query(`
          INSERT INTO tle_history (norad_id, name, tle_line1, tle_line2, epoch, user_id)
          VALUES ($1, $2, $3, $4, $5, $6)
          ON CONFLICT (norad_id, epoch, user_id) DO NOTHING
        `, [norad, name, line1, line2, epochDate, userId]);

        // Insert into tle_derived
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
      } catch (err) {
        console.warn(`Failed for NORAD ${norad}:`, err.message);
      }

      await sleep(1000);
    }

    console.log(`✅ TLE job complete — processed ${storedCount} satellites`);
  } catch (err) {
    console.error('❌ TLE job failed:', err.message);
  } finally {
    // Important: close DB connection so job exits
    await pool.end();
    process.exit(0);
  }
};

// RUN ONCE AND EXIT
fetchAndStoreTLEs();