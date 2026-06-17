'use strict';

const axios = require('axios');

const FRAMEIO_BASE = 'https://api.frame.io/v4';

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

  // No team_id: discover first available team
  const teamsResponse = await axios.get(`${FRAMEIO_BASE}/teams`, { headers: headers() });
  const teams = teamsResponse.data?.data || teamsResponse.data || [];

  if (Array.isArray(teams) && teams.length > 0) {
    const response = await axios.post(`${FRAMEIO_BASE}/teams/${teams[0].id}/projects`, { name }, { headers: headers() });
    return response.data;
  }

  // Fallback: try without team
  const response = await axios.post(`${FRAMEIO_BASE}/projects`, { name }, { headers: headers() });
  return response.data;
}

async function getProject(project_id) {
  const response = await axios.get(`${FRAMEIO_BASE}/projects/${project_id}`, { headers: headers() });
  return response.data;
}

module.exports = { createProject, getProject };
