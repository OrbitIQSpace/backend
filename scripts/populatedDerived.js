// backend/scripts/populateDerived.js — ONE-TIME SCRIPT
import { pool } from '../index.js';

const EARTH_RADIUS_KM = 6378.137;
const GM_KM3_S2 = 398600.4418;

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

const populateDerived = async () => {
  console.log('Populating tle_derived from tle_history...');

  const { rows } = await pool.query(`
    SELECT id, norad_id, name, tle_line1, tle_line2, epoch 
    FROM tle_history 
    ORDER BY epoch
  `);

  let count = 0;
  for (const row of rows) {
    const derived = calculateDerived(row.tle_line1, row.tle_line2);
    if (!derived) continue;

    await pool.query(`
      INSERT INTO tle_derived (
        norad_id, name, epoch,
        inclination, eccentricity, mean_motion,
        semi_major_axis_km, perigee_km, apogee_km,
        orbital_period_minutes, altitude_km, velocity_kms,
        raan, arg_perigee, mean_anomaly,
        bstar, mean_motion_dot, mean_motion_ddot
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
      )
      ON CONFLICT (norad_id, epoch) DO UPDATE SET
        name = EXCLUDED.name,
        inclination = EXCLUDED.inclination,
        eccentricity = EXCLUDED.eccentricity,
        mean_motion = EXCLUDED.mean_motion,
        semi_major_axis_km = EXCLUDED.semi_major_axis_km,
        perigee_km = EXCLUDED.perigee_km,
        apogee_km = EXCLUDED.apogee_km,
        orbital_period_minutes = EXCLUDED.orbital_period_minutes,
        altitude_km = EXCLUDED.altitude_km,
        velocity_kms = EXCLUDED.velocity_kms,
        raan = EXCLUDED.raan,
        arg_perigee = EXCLUDED.arg_perigee,
        mean_anomaly = EXCLUDED.mean_anomaly,
        bstar = EXCLUDED.bstar,
        mean_motion_dot = EXCLUDED.mean_motion_dot,
        mean_motion_ddot = EXCLUDED.mean_motion_ddot
    `, [
      row.norad_id, row.name, row.epoch,
      derived.inclination, derived.eccentricity, derived.mean_motion,
      derived.semi_major_axis_km, derived.perigee_km, derived.apogee_km,
      derived.orbital_period_minutes, derived.altitude_km, derived.velocity_kms,
      derived.raan, derived.arg_perigee, derived.mean_anomaly,
      derived.bstar, derived.mean_motion_dot, derived.mean_motion_ddot
    ]);

    count++;
  }

  console.log(`Successfully populated ${count} records into tle_derived`);
  process.exit(0);
};

populateDerived().catch(err => {
  console.error('Failed:', err);
  process.exit(1);
});