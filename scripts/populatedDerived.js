// backend/scripts/populateDerived.js — SHARED TLE PARSER FOR PRODUCTION
const EARTH_RADIUS_KM = 6378.137;
const GM_KM3_S2 = 398600.4418;

/**
 * Parses raw TLE lines and returns full derived orbital parameters
 * Used in both fetchDailyTLEs and add-satellite routes
 */
export const populateDerived = (line1, line2) => {
  if (!line1 || !line2) return null;

  const meanMotion = parseFloat(line2.slice(52, 63));
  if (!meanMotion || meanMotion <= 0) return null;

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