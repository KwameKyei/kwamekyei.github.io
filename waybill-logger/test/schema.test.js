// The extraction schema must stay within the API's structured-output limits.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { WAYBILL_SCHEMA } from '../lib/extract.js';

function countUnions(node) {
  if (!node || typeof node !== 'object') return 0;
  const self = Array.isArray(node.type) || node.anyOf ? 1 : 0;
  return self + Object.values(node).reduce((n, v) => n + countUnions(v), 0);
}

function checkAgainstSchema(schema, value, at = '$') {
  const types = [].concat(schema.type);
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  assert.ok(types.includes(actual), `${at}: ${actual} is not ${types.join('|')}`);
  if (actual === 'object') {
    assert.deepEqual(Object.keys(value).sort(), [...schema.required].sort(), `${at}: keys`);
    for (const k of schema.required) checkAgainstSchema(schema.properties[k], value[k], `${at}.${k}`);
  }
  if (actual === 'array') value.forEach((v, i) => checkAgainstSchema(schema.items, v, `${at}[${i}]`));
}

test('schema has at most 16 nullable/union fields (API limit)', () => {
  assert.ok(countUnions(WAYBILL_SCHEMA) <= 16, `has ${countUnions(WAYBILL_SCHEMA)}`);
});

test('every field is required and objects are closed', () => {
  (function walk(s) {
    if (s.type === 'object') {
      assert.equal(s.additionalProperties, false);
      assert.deepEqual([...s.required].sort(), Object.keys(s.properties).sort());
      Object.values(s.properties).forEach(walk);
    }
    if (s.items) walk(s.items);
  })(WAYBILL_SCHEMA);
});

test('sample fixtures match the schema the model must follow', () => {
  for (const name of ['extraction-ok.json', 'extraction-problems.json']) {
    const x = JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url)));
    checkAgainstSchema(WAYBILL_SCHEMA, x, name);
  }
});
