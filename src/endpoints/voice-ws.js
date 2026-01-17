import http from 'node:http';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { getUserDirectories } from '../users.js';

/**
 * @typedef {Object} MessageCommand
 * @property {'message'} action
 * @property {string} text
 */

/**
 * @typedef {Object} SwitchCommand
 * @property {'switch'} action
 * @property {string} character
 */

/**
 * @typedef {Object} GenerateCommand
 * @property {'generate'} action
 * @property {Object} body - The full request body to send to /api/backends/chat-completions/generate
 */

/**
 * @typedef {Object} AuthCommand
 * @property {'auth'} action
 * @property {string} csrfToken - CSRF token from /csrf-token endpoint
 */

/**
 * @typedef {MessageCommand | SwitchCommand | GenerateCommand | AuthCommand} VoiceCommand
 */

/**
 * @typedef {Object} StreamChunk
 * @property {'chunk'} type
 * @property {string} text
 */

/**
 * @typedef {Object} StreamEnd
 * @property {'end'} type
 */

/**
 * @typedef {Object} CharacterSwitched
 * @property {'character_switched'} type
 * @property {string} character
 */

/**
 * @typedef {Object} ErrorResponse
 * @property {'error'} type
 * @property {string} message
 */

/**
 * @typedef {StreamChunk | StreamEnd | CharacterSwitched | ErrorResponse} VoiceResponse
 */

/**
 * VoiceWebSocketServer manages WebSocket connections for voice commands
 */
export class VoiceWebSocketServer {
    /** @type {WebSocketServer | null} */
    #wss = null;

    /** @type {NodeJS.Timeout | null} */
    #pingInterval = null;

    /**
     * Initialize the WebSocket server and attach to HTTP server
     * @param {http.Server | https.Server} server - HTTP or HTTPS server instance
     * @param {import('express').Express} app - Express application for session handling
     */
    initialize(server, app) {
        this.#wss = new WebSocketServer({
            noServer: true,
            path: '/ws/voice',
        });

        server.on('upgrade', (request, socket, head) => {
            const pathname = new URL(request.url || '', `http://${request.headers.host}`).pathname;

            if (pathname === '/ws/voice') {
                this.#wss.handleUpgrade(request, socket, head, (ws) => {
                    this.#wss.emit('connection', ws, request);
                });
            } else {
                socket.destroy();
            }
        });

        this.#wss.on('connection', (ws, request) => {
            this.#handleConnection(ws, request);
        });

        this.#startHeartbeat();
        console.log('Voice WebSocket server initialized at /ws/voice');
    }

    /**
     * Handle new WebSocket connection
     * @param {WebSocket & { user?: Object, currentCharacter?: string, isAlive?: boolean }} ws
     * @param {http.IncomingMessage} request
     */
    #handleConnection(ws, request) {
        ws.isAlive = true;

        // Extract user from session cookie if available
        this.#authenticateConnection(ws, request);

        ws.on('pong', () => {
            ws.isAlive = true;
        });

        ws.on('message', async (data) => {
            try {
                const message = JSON.parse(data.toString());
                await this.#handleCommand(ws, message);
            } catch (error) {
                this.#sendError(ws, 'Invalid JSON message');
            }
        });

        ws.on('close', () => {
            console.log('Voice WebSocket client disconnected');
        });

        ws.on('error', (error) => {
            console.error('Voice WebSocket error:', error);
        });

        // Send welcome message
        this.#send(ws, { type: 'chunk', text: 'Connected to voice WebSocket' });
        this.#send(ws, { type: 'end' });
    }

    /**
     * Authenticate the WebSocket connection and extract cookies
     * @param {WebSocket & { user?: Object, cookies?: string, csrfToken?: string }} ws
     * @param {http.IncomingMessage} request
     */
    #authenticateConnection(ws, request) {
        try {
            // Default user handle for single-user mode
            const handle = 'default-user';
            ws.user = {
                directories: getUserDirectories(handle),
                profile: { handle },
            };

            // Store cookies from the upgrade request for later API calls
            if (request.headers.cookie) {
                ws.cookies = request.headers.cookie;
            }
        } catch (error) {
            console.warn('Could not set user directories for WebSocket connection');
        }
    }

    /**
     * Handle incoming command from client
     * @param {WebSocket & { user?: Object, currentCharacter?: string, csrfToken?: string }} ws
     * @param {VoiceCommand} command
     */
    async #handleCommand(ws, command) {
        switch (command.action) {
            case 'auth':
                this.#handleAuthCommand(ws, command);
                break;
            case 'message':
                await this.#handleMessageCommand(ws, command);
                break;
            case 'switch':
                await this.#handleSwitchCommand(ws, command);
                break;
            case 'generate':
                await this.#handleGenerateCommand(ws, command);
                break;
            default:
                this.#sendError(ws, `Unknown action: ${command.action}`);
        }
    }

    /**
     * Handle auth command - sets CSRF token for API calls
     * @param {WebSocket & { csrfToken?: string }} ws
     * @param {AuthCommand} command
     */
    #handleAuthCommand(ws, command) {
        const { csrfToken } = command;
        if (csrfToken && typeof csrfToken === 'string') {
            ws.csrfToken = csrfToken;
            this.#send(ws, { type: 'chunk', text: 'Authentication configured' });
            this.#send(ws, { type: 'end' });
        } else {
            this.#sendError(ws, 'CSRF token is required');
        }
    }

    /**
     * Handle message command - sends text to chat
     * @param {WebSocket & { user?: Object, currentCharacter?: string }} ws
     * @param {MessageCommand} command
     */
    async #handleMessageCommand(ws, command) {
        const { text } = command;

        if (!text || typeof text !== 'string') {
            this.#sendError(ws, 'Message text is required');
            return;
        }

        console.log(`[Voice WS] Received message: "${text}"`);

        // Emit event that can be listened to by other parts of the system
        const { serverEvents, EVENT_NAMES } = await import('../server-events.js');

        // Emit the voice message event
        serverEvents.emit(EVENT_NAMES.VOICE_MESSAGE, {
            text,
            character: ws.currentCharacter,
            user: ws.user,
            // Callback to stream response chunks back to client
            streamChunk: (chunk) => this.#send(ws, { type: 'chunk', text: chunk }),
            streamEnd: () => this.#send(ws, { type: 'end' }),
        });

        // For demo purposes, echo back the message
        // In production, this would be replaced by actual chat integration
        this.#send(ws, { type: 'chunk', text: `Received: "${text}"` });

        if (ws.currentCharacter) {
            this.#send(ws, { type: 'chunk', text: ` (current character: ${ws.currentCharacter})` });
        }

        this.#send(ws, { type: 'end' });
    }

    /**
     * Handle switch command - changes the active character
     * @param {WebSocket & { currentCharacter?: string, user?: Object }} ws
     * @param {SwitchCommand} command
     */
    async #handleSwitchCommand(ws, command) {
        const { character } = command;

        if (!character || typeof character !== 'string') {
            this.#sendError(ws, 'Character name is required');
            return;
        }

        console.log(`[Voice WS] Switching to character: "${character}"`);

        // Store the current character on the connection
        ws.currentCharacter = character;

        // Emit event for character switch
        const { serverEvents, EVENT_NAMES } = await import('../server-events.js');
        serverEvents.emit(EVENT_NAMES.VOICE_SWITCH, {
            character,
            user: ws.user,
        });

        this.#send(ws, { type: 'character_switched', character });
    }

    /**
     * Handle generate command - calls the chat-completions endpoint and streams response
     * @param {WebSocket & { user?: Object, currentCharacter?: string, cookies?: string, csrfToken?: string }} ws
     * @param {GenerateCommand} command
     */
    async #handleGenerateCommand(ws, command) {
        const { body } = command;

        if (!body || typeof body !== 'object') {
            this.#sendError(ws, 'Request body is required for generate action');
            return;
        }

        // Ensure streaming is enabled
        body.stream = true;

        console.log(`[Voice WS] Generate request for model: ${body.model || 'unknown'}`);

        try {
            const headers = {
                'Content-Type': 'application/json',
                'Accept': 'text/event-stream',
            };

            // Add authentication headers if available
            if (ws.cookies) {
                headers['Cookie'] = ws.cookies;
            }
            if (ws.csrfToken) {
                headers['X-CSRF-Token'] = ws.csrfToken;
            }

            const response = await fetch('http://127.0.0.1:8000/api/backends/chat-completions/generate', {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errorText = await response.text();
                this.#sendError(ws, `Generation failed: ${response.status} ${errorText}`);
                return;
            }

            // Process SSE stream
            await this.#processSSEStream(ws, response);
        } catch (error) {
            console.error('[Voice WS] Generate error:', error);
            this.#sendError(ws, `Generation error: ${error.message}`);
        }
    }

    /**
     * Process Server-Sent Events stream and forward to WebSocket
     * @param {WebSocket} ws
     * @param {Response} response
     */
    async #processSSEStream(ws, response) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    this.#send(ws, { type: 'end' });
                    break;
                }

                buffer += decoder.decode(value, { stream: true });

                // Process complete SSE events
                const lines = buffer.split('\n');
                buffer = lines.pop() || ''; // Keep incomplete line in buffer

                for (const line of lines) {
                    if (line.startsWith('data: ')) {
                        const data = line.slice(6);

                        if (data === '[DONE]') {
                            this.#send(ws, { type: 'end' });
                            return;
                        }

                        try {
                            const parsed = JSON.parse(data);
                            // Handle OpenAI-style streaming response
                            const content = parsed.choices?.[0]?.delta?.content
                                || parsed.choices?.[0]?.text
                                || parsed.content
                                || '';

                            if (content) {
                                this.#send(ws, { type: 'chunk', text: content });
                            }
                        } catch {
                            // Non-JSON data line, might be a raw text chunk
                            if (data.trim()) {
                                this.#send(ws, { type: 'chunk', text: data });
                            }
                        }
                    }
                }
            }
        } catch (error) {
            console.error('[Voice WS] Stream processing error:', error);
            this.#sendError(ws, `Stream error: ${error.message}`);
        } finally {
            reader.releaseLock();
        }
    }

    /**
     * Send a response to the client
     * @param {WebSocket} ws
     * @param {VoiceResponse} response
     */
    #send(ws, response) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(response));
        }
    }

    /**
     * Send an error response to the client
     * @param {WebSocket} ws
     * @param {string} message
     */
    #sendError(ws, message) {
        this.#send(ws, { type: 'error', message });
    }

    /**
     * Start heartbeat to detect dead connections
     */
    #startHeartbeat() {
        this.#pingInterval = setInterval(() => {
            this.#wss?.clients.forEach((ws) => {
                if (!ws.isAlive) {
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping();
            });
        }, 30000);
    }

    /**
     * Broadcast a message to all connected clients
     * @param {VoiceResponse} response
     */
    broadcast(response) {
        this.#wss?.clients.forEach((client) => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(response));
            }
        });
    }

    /**
     * Clean up resources
     */
    dispose() {
        if (this.#pingInterval) {
            clearInterval(this.#pingInterval);
        }
        this.#wss?.close();
    }
}

// Singleton instance
export const voiceWs = new VoiceWebSocketServer();
