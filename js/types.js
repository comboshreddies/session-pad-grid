/**
 * @module types
 * JSDoc typedefs for pack/session (documentation for AI + editors).
 */

/**
 * @typedef {Object} PackState
 * @property {string} slug
 * @property {string} title
 * @property {number} tempo
 * @property {number} patternLength
 * @property {Array<Array<Object>>} channels
 * @property {number} nCols
 * @property {number} nRows
 * @property {Array<Array<Object>>} sessionChannelsFull
 * @property {number} nSessionRowsFull
 * @property {number} sessionRowScrollOffset
 * @property {Map<string, object>} byId
 * @property {object} raw
 */

/**
 * @typedef {'idle'|'armed'|'playing'|'pending-off'} PadPlaybackVisual
 */

export {};
