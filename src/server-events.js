import EventEmitter from 'node:events';
import process from 'node:process';

/**
 * @typedef {import('../index').ServerEventMap} ServerEventMap
 * @type {EventEmitter<ServerEventMap>} The default event source.
 */
export const serverEvents = new EventEmitter();
process.serverEvents = serverEvents;
export default serverEvents;

/**
 * @enum {string}
 * @readonly
 */
export const EVENT_NAMES = Object.freeze({
    /**
     * Emitted when the server has started.
     */
    SERVER_STARTED: 'server-started',
    /**
     * Emitted when a voice message is received via WebSocket.
     */
    VOICE_MESSAGE: 'voice:message',
    /**
     * Emitted when a character switch is requested via WebSocket.
     */
    VOICE_SWITCH: 'voice:switch',
});
