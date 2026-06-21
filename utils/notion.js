'use strict';

const { Client } = require('@notionhq/client');

let _client;

function getClient() {
  if (!_client) {
    _client = new Client({ auth: process.env.NOTION_API_KEY, timeoutMs: 15000 });
  }
  return _client;
}

async function createPage(database_id, properties) {
  return await getClient().pages.create({
    parent: { database_id },
    properties,
  });
}

async function updatePage(page_id, properties) {
  return await getClient().pages.update({ page_id, properties });
}

async function queryDatabase(database_id, filter, start_cursor) {
  const params = { database_id };
  if (filter) params.filter = filter;
  if (start_cursor) params.start_cursor = start_cursor;
  return await getClient().databases.query(params);
}

async function getPage(page_id) {
  return await getClient().pages.retrieve({ page_id });
}

module.exports = { createPage, updatePage, queryDatabase, getPage };
