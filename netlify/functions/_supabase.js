// netlify/functions/_supabase.js
// Cliente Supabase compartido + helpers de respuesta.
// Usa la SERVICE ROLE key (solo del lado servidor, nunca en el browser).

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

// Cliente único reutilizable
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
  auth: { persistSession: false }
});

// CORS abierto (el portal y la API viven en el mismo dominio Netlify,
// pero dejamos CORS por si servís el HTML desde otro lado).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Content-Type': 'application/json'
};

function ok(body) {
  return { statusCode: 200, headers: CORS, body: JSON.stringify(body) };
}
function bad(code, error) {
  return { statusCode: code, headers: CORS, body: JSON.stringify({ success: false, error }) };
}
function preflight() {
  return { statusCode: 204, headers: CORS, body: '' };
}

module.exports = { supabase, CORS, ok, bad, preflight };
