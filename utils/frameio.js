'use strict';

const axios = require('axios');

const FRAMEIO_BASE = 'https://api.frame.io/v2';

function headers() {
  return {
    Authorization: `Bearer ${process.env.FRAMEIO_API_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function createProject(name, team_id) {
  const tid = team_id || process.env.FRAMEIO_TEAM_ID;

  if (tid) {
    const response = await axios.post(`${FRAMEIO_BASE}/teams/${tid}/projects`, { name }, { headers: headers() });
    return response.data;
  }

  const accountId = process.env.FRAMEIO_ACCOUNT_ID;

  if (accountId) {
    const response = await axios.post(`${FRAMEIO_BASE}/accounts/${accountId}/projects`, { name }, { headers: headers() });
    console.log(`[FRAMEIO] Project created via /accounts endpoint`);
    return response.data;
  }

  // Discover account ID via /me — fallback when FRAMEIO_ACCOUNT_ID not set
  const meResponse = await axios.get(`${FRAMEIO_BASE}/me`, { headers: headers() });
  const me = meResponse.data;
  console.log(`[FRAMEIO] /me: account_id=${me.account_id}, from_adobe=${me.from_adobe}`);

  if (me.account_id) {
    try {
      const res = await axios.post(`${FRAMEIO_BASE}/accounts/${me.account_id}/projects`, { name }, { headers: headers() });
      console.log(`[FRAMEIO] Project created via /accounts endpoint`);
      return res.data;
    } catch (e) {
      console.warn(`[FRAMEIO] /accounts/${me.account_id}/projects failed: ${e.response?.status} ${e.message}`);
    }

    try {
      const teamsRes = await axios.get(`${FRAMEIO_BASE}/accounts/${me.account_id}/teams`, { headers: headers() });
      const teams = teamsRes.data?.data || teamsRes.data || [];
      if (Array.isArray(teams) && teams.length > 0) {
        console.log(`[FRAMEIO] Found team: ${teams[0].id} (${teams[0].name})`);
        const res = await axios.post(`${FRAMEIO_BASE}/teams/${teams[0].id}/projects`, { name }, { headers: headers() });
        return res.data;
      }
    } catch (e) {
      console.warn(`[FRAMEIO] /accounts/${me.account_id}/teams failed: ${e.response?.status} ${e.message}`);
    }
  }

  const response = await axios.post(`${FRAMEIO_BASE}/projects`, { name }, { headers: headers() });
  return response.data;
}

async function getProject(project_id) {
  const response = await axios.get(`${FRAMEIO_BASE}/projects/${project_id}`, { headers: headers() });
  return response.data;
}

module.exports = { createProject, getProject };
