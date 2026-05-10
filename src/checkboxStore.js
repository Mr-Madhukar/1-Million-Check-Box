'use strict';
const { redis } = require('./redisClient');

const BITMAP_KEY = 'checkboxes:bits';
const CHECKBOX_COUNT = parseInt(process.env.CHECKBOX_COUNT || '2000', 10);

/**
 * Get the state of a single checkbox.
 * @param {number} index
 * @returns {Promise<boolean>}
 */
async function getCheckboxBit(index) {
  const val = await redis.getbit(BITMAP_KEY, index);
  return val === 1;
}

/**
 * Set the state of a single checkbox.
 * @param {number} index
 * @param {boolean} value
 * @returns {Promise<void>}
 */
async function setCheckboxBit(index, value) {
  await redis.setbit(BITMAP_KEY, index, value ? 1 : 0);
}

/**
 * Get all checkbox bytes as a Buffer (binary bitmap).
 * The bitmap is lazily created by Redis when first written to.
 * If the key doesn't exist yet, returns a zero-filled buffer.
 * @returns {Promise<Buffer>}
 */
async function getAllCheckboxBytes() {
  const buf = await redis.getBuffer(BITMAP_KEY);
  if (!buf) {
    // Return zero-filled buffer (all unchecked)
    const byteLen = Math.ceil(CHECKBOX_COUNT / 8);
    return Buffer.alloc(byteLen);
  }
  return buf;
}

/**
 * Count the total number of checked checkboxes using Redis BITCOUNT.
 * @returns {Promise<number>}
 */
async function countChecked() {
  const count = await redis.bitcount(BITMAP_KEY);
  return count;
}

module.exports = { getCheckboxBit, setCheckboxBit, getAllCheckboxBytes, countChecked, CHECKBOX_COUNT };
