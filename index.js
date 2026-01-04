// ------------------------- LOAD ENV FIRST (CRITICAL FOR ESM) -------------------------
import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.resolve(__dirname, '.env') });

// ------------------------- NOW IMPORT EVERYTHING ELSE -------------------------
import express from "express";
import { Pool } from "pg";
import axios from "axios";
import multer from "multer";
import csv from "csv-parser";
import { createReadStream, unlinkSync } from "fs";
import { ClerkExpressRequireAuth } from '@clerk/clerk-sdk-node';

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

// CORS — allow Vercel frontend (orbitiqspace.com) and localhost
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowedOrigins = [
    'http://localhost:3001',
    'https://orbitiqspace.com',
    'https://www.orbitiqspace.com',
  ];

  if (allowedOrigins.includes(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  }

  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Credentials', 'true');

  if (req.method === 'OPTIONS') {
    return res.sendStatus(200);
  }
  next();
});

const upload = multer({ dest: "uploads/" });

// ------------------------- DATABASE — SUPPORTS DATABASE_URL -------------------------
// Prioritizes DATABASE_URL (Render, Railway, Supabase standard)
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false, // Required for hosted DBs
  // Fallback for local development
  user: process.env.DB_USER || "postgres",
  host: process.env.DB_HOST || "localhost",
  database: process.env.DB_NAME || "orbitiq",
  password: process.env.DB_PASS,
  port: process.env.DB_PORT || 5432,
});

// AUTO-ADD COLUMNS + user_id + COMPOSITE KEY
const initDatabase = async () => {
  try {
    await pool.query(`
      ALTER TABLE satellites
      ADD COLUMN IF NOT EXISTS tle_line1 TEXT,
      ADD COLUMN IF NOT EXISTS tle_line2 TEXT,
      ADD COLUMN IF NOT EXISTS eccentricity FLOAT,
      ADD COLUMN IF NOT EXISTS semi_major_axis FLOAT,
      ADD COLUMN IF NOT EXISTS perigee FLOAT,
      ADD COLUMN IF NOT EXISTS apogee FLOAT,
      ADD COLUMN IF NOT EXISTS period FLOAT,
      ADD COLUMN IF NOT EXISTS altitude INTEGER,
      ADD COLUMN IF NOT EXISTS orbit_type TEXT,
      ADD COLUMN IF NOT EXISTS orbital_velocity_kms TEXT,
      ADD COLUMN IF NOT EXISTS orbital_velocity_kmh INTEGER,
      ADD COLUMN IF NOT EXISTS user_id TEXT;

      ALTER TABLE tle_history ADD COLUMN IF NOT EXISTS user_id TEXT;
      ALTER TABLE tle_derived ADD COLUMN IF NOT EXISTS user_id TEXT;
      ALTER TABLE telemetry ADD COLUMN IF NOT EXISTS user_id TEXT;
    `);

    // Fill NULL user_id with admin (safe for legacy data)
    await pool.query(`
      UPDATE satellites SET user_id = 'user_37CroUWyRbmd5cUfH2s9DKm2BoQ' WHERE user_id IS NULL;
      UPDATE tle_history SET user_id = 'user_37CroUWyRbmd5cUfH2s9DKm2BoQ' WHERE user_id IS NULL;
      UPDATE tle_derived SET user_id = 'user_37CroUWyRbmd5cUfH2s9DKm2BoQ' WHERE user_id IS NULL;
      UPDATE telemetry SET user_id = 'user_37CroUWyRbmd5cUfH2s9DKm2BoQ' WHERE user_id IS NULL;
    `);

    // Apply composite primary key
    await pool.query(`
      ALTER TABLE satellites DROP CONSTRAINT IF EXISTS satellites_pkey CASCADE;
      ALTER TABLE satellites DROP CONSTRAINT IF EXISTS satellites_multi_user_key;
      ALTER TABLE satellites ADD CONSTRAINT satellites_multi_user_key PRIMARY KEY (norad_id, user_id);
    `);

    console.log("✅ Database migration successful: Multi-tenancy active");
  } catch (err) {
    console.error("❌ DB init error:", err.message);
  }
};
initDatabase();

// ------------------------- CLERK AUTH MIDDLEWARE -------------------------
const requireAuth = ClerkExpressRequireAuth();

// ------------------------- SPACE-TRACK SESSION -------------------------
let cookies = null;
let lastLogin = 0;
let rateLimitUntil = 0;

const loginToSpaceTrack = async () => {
  if (!process.env.SPACETRACK_USER || !process.env.SPACETRACK_PASS) return false;
  try {
    const resp = await axios.post(
      "https://www.space-track.org/ajaxauth/login",
      `identity=${encodeURIComponent(process.env.SPACETRACK_USER)}&password=${encodeURIComponent(process.env.SPACETRACK_PASS)}`,
      { headers: { "Content-Type": "application/x-www-form-urlencoded" }, maxRedirects: 0 }
    );
    cookies = resp.headers["set-cookie"];
    lastLogin = Date.now();
    rateLimitUntil = 0;
    console.log("Space-Track login successful");
    return true;
  } catch (err) {
    console.error("Login failed:", err.message);
    cookies = null;
    return false;
  }
};

const ensureSession = async () => {
  if (!cookies || Date.now() - lastLogin > 20 * 60 * 1000) {
    await loginToSpaceTrack();
  }
  return !!cookies;
};

// ------------------------- FETCH TLE -------------------------
const fetchFullSatelliteData = async (noradId) => {
  if (!(await ensureSession())) return null;
  if (rateLimitUntil > Date.now()) return null;

  try {
    const url = `https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/${noradId}/orderby/TLE_LINE1%20DESC/format/json`;
    const resp = await axios.get(url, { headers: { Cookie: cookies?.join("; ") || "" } });
    if (!resp.data || resp.data.length === 0) return null;

    const sat = resp.data[0];
    return {
      norad_id: noradId,
      name: sat.OBJECT_NAME?.trim() || "UNKNOWN",
      tle_line1: sat.TLE_LINE1,
      tle_line2: sat.TLE_LINE2,
      inclination: parseFloat(sat.INCLINATION) || 0,
      mean_motion: parseFloat(sat.MEAN_MOTION) || 0,
      eccentricity: parseFloat(sat.ECCENTRICITY) || 0,
      semi_major_axis: parseFloat(sat.SEMIMAJOR_AXIS) || 0,
      perigee: parseFloat(sat.PERIGEE) || 0,
      apogee: parseFloat(sat.APOGEE) || 0,
      period: parseFloat(sat.PERIOD) || 0,
    };
  } catch (err) {
    if (err.response?.status === 429) rateLimitUntil = Date.now() + 60 * 1000;
    return null;
  }
};

// ------------------------- ORBIT CALCULATIONS -------------------------
const calculateDerivedParams = (data) => {
  const meanMotion = data.mean_motion;
  if (!meanMotion || meanMotion <= 0) {
    return { altitude: 0, orbit_type: "UNKNOWN", orbital_velocity_kms: "0.000", orbital_velocity_kmh: 0 };
  }

  const periodSec = 86400 / meanMotion;
  const semiMajorAxis = data.semi_major_axis || Math.cbrt(398600.4418 * Math.pow(periodSec / (2 * Math.PI), 2));
  const altitude = semiMajorAxis - 6378.137;
  const velocityKms = (2 * Math.PI * semiMajorAxis) / periodSec;

  let orbit_type = "UNKNOWN";
  if (altitude < 2000) orbit_type = "LEO";
  else if (altitude < 35786) orbit_type = "MEO";
  else if (Math.abs(altitude - 35786) <= 2000) orbit_type = "GEO";
  else orbit_type = "HEO";

  return {
    altitude: Math.round(altitude),
    orbit_type,
    orbital_velocity_kms: velocityKms.toFixed(3),
    orbital_velocity_kmh: Math.round(velocityKms * 3600),
  };
};

// ------------------------- ROUTES -------------------------

// PUBLIC: Latest ISS TLE
app.get('/api/public/iss', async (req, res) => {
  try {
    if (!(await ensureSession())) return res.status(500).json({ error: "No Space-Track session" });

    const url = `https://www.space-track.org/basicspacedata/query/class/gp/NORAD_CAT_ID/25544/orderby/EPOCH%20desc/format/tle`;
    const response = await axios.get(url, { headers: { Cookie: cookies.join('; ') }, timeout: 10000 });

    const lines = response.data.trim().split('\n').filter(Boolean);
    if (lines.length < 2) return res.status(404).json({ error: "ISS TLE not found" });

    res.json({ name: lines[0] || 'ISS (ZARYA)', line1: lines[1], line2: lines[2] });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch ISS TLE" });
  }
});

// PROTECT ALL ROUTES BELOW THIS LINE
app.use(requireAuth);

// PROTECTED: Satellites list — admin sees all, users see own
app.get("/api/satellites", async (req, res) => {
  try {
    const userId = req.auth.userId;
    const isAdmin = userId === 'user_37CroUWyRbmd5cUfH2s9DKm2BoQ';

    let query = `
      SELECT norad_id, name, orbit_type, altitude, inclination,
             orbital_velocity_kms, orbital_velocity_kmh
      FROM satellites
    `;
    const params = [];

    if (!isAdmin) {
      query += ` WHERE user_id = $1`;
      params.push(userId);
    }

    query += ` ORDER BY name ASC`;

    const result = await pool.query(query, params);
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching satellites:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PROTECTED: Single satellite — per user
app.get("/api/satellite/:norad_id", async (req, res) => {
  const { norad_id } = req.params;
  const userId = req.auth.userId;

  try {
    let result = await pool.query(
      "SELECT * FROM satellites WHERE norad_id::text = $1 AND user_id = $2",
      [norad_id, userId]
    );
    let sat = result.rows[0];

    if (!sat) {
      const fresh = await fetchFullSatelliteData(norad_id);
      if (!fresh) return res.status(404).json({ error: "Satellite not found" });

      const derived = calculateDerivedParams(fresh);

      result = await pool.query(
        `INSERT INTO satellites (
          norad_id, name, tle_line1, tle_line2, inclination, mean_motion,
          eccentricity, semi_major_axis, perigee, apogee, period,
          altitude, orbit_type, orbital_velocity_kms, orbital_velocity_kmh,
          user_id
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
         ON CONFLICT (norad_id, user_id) DO UPDATE SET
          name = EXCLUDED.name,
          tle_line1 = EXCLUDED.tle_line1,
          tle_line2 = EXCLUDED.tle_line2,
          inclination = EXCLUDED.inclination,
          mean_motion = EXCLUDED.mean_motion,
          eccentricity = EXCLUDED.eccentricity,
          semi_major_axis = EXCLUDED.semi_major_axis,
          perigee = EXCLUDED.perigee,
          apogee = EXCLUDED.apogee,
          period = EXCLUDED.period,
          altitude = EXCLUDED.altitude,
          orbit_type = EXCLUDED.orbit_type,
          orbital_velocity_kms = EXCLUDED.orbital_velocity_kms,
          orbital_velocity_kmh = EXCLUDED.orbital_velocity_kmh
         RETURNING *`,
        [
          fresh.norad_id,
          fresh.name,
          fresh.tle_line1,
          fresh.tle_line2,
          fresh.inclination,
          fresh.mean_motion,
          fresh.eccentricity,
          fresh.semi_major_axis,
          fresh.perigee,
          fresh.apogee,
          fresh.period,
          derived.altitude,
          derived.orbit_type,
          derived.orbital_velocity_kms,
          derived.orbital_velocity_kmh,
          userId
        ]
      );

      sat = result.rows[0];
    }

    res.json(sat);
  } catch (err) {
    console.error("Error fetching satellite:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PROTECTED: Add satellite — per user + store full TLE history on add
app.post("/add-satellite", requireAuth, async (req, res) => {
  const { norad_id } = req.body;
  const userId = req.auth.userId;

  if (!norad_id) return res.status(400).json({ error: "Missing NORAD ID" });

  const data = await fetchFullSatelliteData(norad_id);
  if (!data) return res.status(404).json({ error: "Invalid NORAD ID" });

  const derived = calculateDerived(data.tle_line1, data.tle_line2); // ← Use calculateDerived(line1, line2) to parse all fields
  if (!derived) return res.status(500).json({ error: "Failed to calculate derived parameters" });

  // Parse epoch for history tables
  const year = parseInt(data.tle_line1.slice(18, 20));
  const dayOfYear = parseFloat(data.tle_line1.slice(20, 32));
  const fullYear = year < 57 ? 2000 + year : 1900 + year;
  const epochDate = new Date(Date.UTC(fullYear, 0));
  epochDate.setUTCDate(epochDate.getUTCDate() + dayOfYear - 1);
  const fraction = dayOfYear % 1;
  epochDate.setSeconds(epochDate.getSeconds() + fraction * 86400);

  try {
    // 1. Insert/update main satellite record
    await pool.query(
      `INSERT INTO satellites (
        norad_id, name, tle_line1, tle_line2, inclination, mean_motion,
        eccentricity, semi_major_axis, perigee, apogee, period,
        altitude, orbit_type, orbital_velocity_kms, orbital_velocity_kmh,
        user_id
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (norad_id, user_id) DO UPDATE SET
        name = EXCLUDED.name,
        tle_line1 = EXCLUDED.tle_line1,
        tle_line2 = EXCLUDED.tle_line2,
        inclination = EXCLUDED.inclination,
        mean_motion = EXCLUDED.mean_motion,
        eccentricity = EXCLUDED.eccentricity,
        semi_major_axis = EXCLUDED.semi_major_axis,
        perigee = EXCLUDED.perigee,
        apogee = EXCLUDED.apogee,
        period = EXCLUDED.period,
        altitude = EXCLUDED.altitude,
        orbit_type = EXCLUDED.orbit_type,
        orbital_velocity_kms = EXCLUDED.orbital_velocity_kms,
        orbital_velocity_kmh = EXCLUDED.orbital_velocity_kmh`,
      [
        data.norad_id,
        data.name,
        data.tle_line1,
        data.tle_line2,
        derived.inclination, // ← Use derived for all fields
        derived.mean_motion,
        derived.eccentricity,
        derived.semi_major_axis_km,
        derived.perigee_km,
        derived.apogee_km,
        derived.orbital_period_minutes,
        derived.altitude_km,
        derived.orbit_type,
        derived.velocity_kms,
        derived.orbital_period_minutes * 60, // Calculate orbital_velocity_kmh if needed
        userId
      ]
    );

    // 2. Insert into tle_history
    await pool.query(`
      INSERT INTO tle_history (norad_id, name, tle_line1, tle_line2, epoch, user_id)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (norad_id, epoch, user_id) DO NOTHING
    `, [data.norad_id, data.name, data.tle_line1, data.tle_line2, epochDate, userId]);

    // 3. Insert into tle_derived
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
      data.norad_id, data.name, epochDate,
      derived.inclination, derived.eccentricity, derived.mean_motion,
      derived.semi_major_axis_km, derived.perigee_km, derived.apogee_km,
      derived.orbital_period_minutes, derived.altitude_km, derived.velocity_kms,
      derived.raan, derived.arg_perigee, derived.mean_anomaly,
      derived.bstar, derived.mean_motion_dot, derived.mean_motion_ddot,
      userId
    ]);

    res.json({ success: true });
  } catch (err) {
    console.error("DB insert error:", err);
    res.status(500).json({ error: "Database error" });
  }
});
// PROTECTED: tle_derived — filtered by user
app.get('/api/tle_derived/:noradId', async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT 
        epoch,
        inclination,
        eccentricity,
        mean_motion,
        semi_major_axis_km,
        perigee_km,
        apogee_km,
        orbital_period_minutes,
        altitude_km,
        velocity_kms,
        raan,
        arg_perigee,
        mean_anomaly,
        bstar,
        mean_motion_dot,
        mean_motion_ddot
      FROM tle_derived 
      WHERE norad_id = $1 AND user_id = $2
      ORDER BY epoch ASC
    `, [req.params.noradId, req.auth.userId]);

    res.json(rows);
  } catch (err) {
    console.error('tle_derived fetch error:', err);
    res.status(500).json({ error: "Server error" });
  }
});

// PROTECTED: telemetry — filtered by user
app.get("/api/telemetry/:norad_id", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM telemetry WHERE norad_id::text = $1 AND user_id = $2 ORDER BY timestamp DESC",
      [req.params.norad_id, req.auth.userId]
    );
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: "Server error" });
  }
});

// PROTECTED: Delete satellite — only user's own
app.delete("/delete-satellite/:norad_id", async (req, res) => {
  try {
    await pool.query("DELETE FROM satellites WHERE norad_id::text = $1 AND user_id = $2", [req.params.norad_id, req.auth.userId]);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
});

// PROTECTED: Rename satellite — only user's own
app.patch("/api/satellite/:norad_id/rename", async (req, res) => {
  const { norad_id } = req.params;
  const { name } = req.body;

  if (!name || name.trim() === "") {
    return res.status(400).json({ error: "Name cannot be empty" });
  }

  try {
    const result = await pool.query(
      "UPDATE satellites SET name = $1 WHERE norad_id::text = $2 AND user_id = $3 RETURNING *",
      [name.trim(), norad_id, req.auth.userId]
    );

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Satellite not found" });
    }

    res.json({ success: true, satellite: result.rows[0] });
  } catch (err) {
    console.error("Rename error:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PROTECTED: Telemetry upload — with user_id
app.post("/upload/telemetry", upload.single("file"), async (req, res) => {
  const { norad_id } = req.body;
  if (!norad_id) return res.status(400).json({ error: "Missing NORAD ID" });

  const results = [];
  createReadStream(req.file.path)
    .pipe(csv())
    .on("data", (row) => results.push({ ...row, norad_id, user_id: req.auth.userId }))
    .on("end", async () => {
      try {
        for (const row of results) {
          await pool.query(
            "INSERT INTO telemetry (norad_id, timestamp, battery_level, fuel_remaining, user_id) VALUES ($1,$2,$3,$4,$5)",
            [row.norad_id, row.timestamp, row.battery_level, row.fuel_remaining, row.user_id]
          );
        }
        unlinkSync(req.file.path);
        res.json({ success: true });
      } catch (err) {
        console.error("Telemetry upload error:", err);
        res.status(500).json({ error: "Upload failed" });
      }
    });
});

// Global Error Handler
app.use((err, req, res, next) => {
  if (err.message === 'Unauthenticated') return res.status(401).json({ error: "Authentication Required" });
  console.error(err.stack);
  res.status(500).json({ error: "Internal Server Error" });
});

export { pool };

// ------------------------- START SERVER -------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`ORBITIQ BACKEND vFINAL — LIVE ON PORT ${PORT}`);
});