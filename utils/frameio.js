'use strict';

const axios = require('axios');

const FRAMEIO_BASE = 'https://api.frame.io/v2';

function headers() {
  return {
    Authorization: `Bearer ${process.env.FRAMEIO_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function discoverTeamId() {
  // Try /me first — works with any valid developer token
  const meResponse = await axios.get(`${FRAMEIO_BASE}/me`, { headers: headers() });
  const me = meResponse.data;
  console.log(`[FRAMEIO] /me response: account_id=${me.account_id}, id=${me.id}`);

  // Try account-scoped teams endpoint
  if (me.account_id) {
    try {
      const res = await axios.get(`${FRAMEIO_BASE}/accounts/${me.account_id}/teams`, { headers: headers() });
      const teams = res.data?.data || res.data || [];
      if (Array.isArray(teams) && teams.length > 0) {
        console.log(`[FRAMEIO] Found team via /accounts: ${teams[0].id} (${teams[0].name})`);
        return teams[0].id;
      }
    } catch (e) {
      console.warn(`[FRAMEIO] /accounts/${me.account_id}/teams failed: ${e.message}`);
    }
  }

  // Try flat /teams endpoint
  try {
    const res = await axios.get(`${FRAMEIO_BASE}/teams`, { headers: headers() });
    const teams = res.data?.data || res.data || [];
    if (Array.isArray(teams) && teams.length > 0) {
      console.log(`[FRAMEIO] Found team via /teams: ${teams[0].id} (${teams[0].name})`);
      return teams[0].id;
    }
  } catch (e) {
    console.warn(`[FRAMEIO] /teams failed: ${e.message}`);
  }

  // Log the full /me payload so we can inspect the structure
  console.warn('[FRAMEIO] Could not discover team ID. /me payload:', JSON.stringify(me).slice(0, 500));
  return null;
}

async function createProject(name, team_id) {
  const tid = team_id || process.env.FRAMEIO_TEAM_ID;

  if (tid) {
    const response = await axios.post(`${FRAMEIO_BASE}/teams/${tid}/projects`, { name }, { headers: headers() });
    return response.data;
  }

  const discoveredId = await discoverTeamId();

  if (discoveredId) {
    const response = await axios.post(`${FRAMEIO_BASE}/teams/${discoveredId}/projects`, { name }, { headers: headers() });
    return response.data;
  }

  // Final fallback: project without team scope
  const response = await axios.post(`${FRAMEIO_BASE}/projects`, { name }, { headers: headers() });
  return response.data;
}

async function getProject(project_id) {
  const response = await axios.get(`${FRAMEIO_BASE}/projects/${project_id}`, { headers: headers() });
  return response.data;
}

module.exports = { createProject, getProject };
