import http from 'node:http';
import https from 'node:https';
import { WebSocketServer, WebSocket } from 'ws';
import { getUserDirectories } from '../users.js';
import { headlessBrowser } from '../services/headless-browser.js';

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
 * @typedef {Object} StatusCommand
 * @property {'status'} action
 */

/**
 * @typedef {Object} CharactersCommand
 * @property {'characters'} action
 */

/**
 * @typedef {Object} HistoryCommand
 * @property {'history'} action
 */

/**
 * @typedef {Object} StopCommand
 * @property {'stop'} action
 */

/**
 * @typedef {MessageCommand | SwitchCommand | GenerateCommand | AuthCommand | StatusCommand | CharactersCommand | HistoryCommand | StopCommand} VoiceCommand
 */

/**
 * @typedef {Object} StreamChunk
 * @property {'chunk'} type
 * @property {string} text
 */

/**
 * @typedef {Object} StreamEnd
 * @property {'end'} type
 * @property {string} [fullText] - Complete response text
 */

/**
 * @typedef {Object} CharacterSwitched
 * @property {'character_switched'} type
 * @property {string} character
 */

/**
 * @typedef {Object} StatusResponse
 * @property {'status'} type
 * @property {boolean} ready
 * @property {string|null} character
 * @property {boolean} headlessReady
 */

/**
 * @typedef {Object} CharactersResponse
 * @property {'characters'} type
 * @property {Array<{name: string, avatar: string}>} characters
 */

/**
 * @typedef {Object} HistoryResponse
 * @property {'history'} type
 * @property {Array<{is_user: boolean, mes: string, name: string}>} messages
 */

/**
 * @typedef {Object} ErrorResponse
 * @property {'error'} type
 * @property {string} message
 */

/**
 * @typedef {StreamChunk | StreamEnd | CharacterSwitched | StatusResponse | CharactersResponse | HistoryResponse | ErrorResponse} VoiceResponse
 */

/**
 * VoiceWebSocketServer manages WebSocket connections for voice commands
 * Uses a headless browser to leverage ST's full prompt-building logic
 */
export class VoiceWebSocketServer {
    /** @type {WebSocketServer | null} */
    #wss = null;

    /** @type {NodeJS.Timeout | null} */
    #pingInterval = null;

    /** @type {boolean} */
    #headlessInitialized = false;

    /** @type {Promise<void> | null} */
    #headlessInitPromise = null;

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

        // Start headless browser initialization in background
        this.#initHeadlessBrowser();
    }

    /**
     * Initialize the headless browser (lazy, on first connection or explicitly)
     * @returns {Promise<void>}
     */
    async #initHeadlessBrowser() {
        if (this.#headlessInitialized) {
            return;
        }

        if (this.#headlessInitPromise) {
            return this.#headlessInitPromise;
        }

        this.#headlessInitPromise = (async () => {
            try {
                await headlessBrowser.initialize();
                this.#headlessInitialized = true;
                console.log('[Voice WS] Headless browser ready');
            } catch (error) {
                console.error('[Voice WS] Failed to initialize headless browser:', error);
                this.#headlessInitPromise = null; // Allow retry
            }
        })();

        return this.#headlessInitPromise;
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

        // Send welcome message with status
        this.#send(ws, {
            type: 'status',
            ready: true,
            character: null,
            headlessReady: this.#headlessInitialized,
        });
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
            case 'status':
                await this.#handleStatusCommand(ws);
                break;
            case 'characters':
                await this.#handleCharactersCommand(ws);
                break;
            case 'history':
                await this.#handleHistoryCommand(ws);
                break;
            case 'message':
                await this.#handleMessageCommand(ws, command);
                break;
            case 'switch':
                await this.#handleSwitchCommand(ws, command);
                break;
            case 'stop':
                await this.#handleStopCommand(ws);
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
     * Handle status command - returns current state
     * @param {WebSocket} ws
     */
    async #handleStatusCommand(ws) {
        let character = null;

        if (this.#headlessInitialized) {
            try {
                character = await headlessBrowser.getCurrentCharacter();
            } catch {
                // Ignore
            }
        }

        this.#send(ws, {
            type: 'status',
            ready: true,
            character,
            headlessReady: this.#headlessInitialized,
        });
    }

    /**
     * Handle characters command - returns available characters
     * @param {WebSocket} ws
     */
    async #handleCharactersCommand(ws) {
        if (!this.#headlessInitialized) {
            await this.#initHeadlessBrowser();
        }

        if (!this.#headlessInitialized) {
            this.#sendError(ws, 'Headless browser not ready');
            return;
        }

        try {
            const characters = await headlessBrowser.getCharacterList();
            this.#send(ws, { type: 'characters', characters });
        } catch (error) {
            this.#sendError(ws, `Failed to get characters: ${error.message}`);
        }
    }

    /**
     * Handle history command - returns chat history
     * @param {WebSocket} ws
     */
    async #handleHistoryCommand(ws) {
        if (!this.#headlessInitialized) {
            this.#sendError(ws, 'Headless browser not ready');
            return;
        }

        try {
            const messages = await headlessBrowser.getChatHistory();
            this.#send(ws, { type: 'history', messages });
        } catch (error) {
            this.#sendError(ws, `Failed to get history: ${error.message}`);
        }
    }

    /**
     * Handle message command - sends text to chat via headless browser
     * @param {WebSocket & { user?: Object, currentCharacter?: string }} ws
     * @param {MessageCommand} command
     */
    async #handleMessageCommand(ws, command) {
        const { text } = command;

        if (!text || typeof text !== 'string') {
            this.#sendError(ws, 'Message text is required');
            return;
        }

        // Ensure headless browser is ready
        if (!this.#headlessInitialized) {
            await this.#initHeadlessBrowser();
        }

        if (!this.#headlessInitialized) {
            this.#sendError(ws, 'Headless browser not ready. Please wait and try again.');
            return;
        }

        console.log(`[Voice WS] Sending message via headless browser: "${text.substring(0, 50)}${text.length > 50 ? '...' : ''}"`);

        try {
            // Send message through headless browser and stream response
            const result = await headlessBrowser.sendMessage(text, (chunk) => {
                this.#send(ws, { type: 'chunk', text: chunk });
            });

            if (result.success) {
                this.#send(ws, { type: 'end', fullText: result.text });
            } else {
                this.#sendError(ws, result.error || 'Generation failed');
            }
        } catch (error) {
            console.error('[Voice WS] Message error:', error);
            this.#sendError(ws, `Message error: ${error.message}`);
        }
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

        // Ensure headless browser is ready
        if (!this.#headlessInitialized) {
            await this.#initHeadlessBrowser();
        }

        if (!this.#headlessInitialized) {
            this.#sendError(ws, 'Headless browser not ready');
            return;
        }

        console.log(`[Voice WS] Switching to character: "${character}"`);

        try {
            const success = await headlessBrowser.selectCharacter(character);

            if (success) {
                ws.currentCharacter = character;
                const actualName = await headlessBrowser.getCurrentCharacter();
                this.#send(ws, { type: 'character_switched', character: actualName || character });
            } else {
                this.#sendError(ws, `Failed to switch to character "${character}"`);
            }
        } catch (error) {
            console.error('[Voice WS] Switch error:', error);
            this.#sendError(ws, `Switch error: ${error.message}`);
        }
    }

    /**
     * Handle stop command - stops ongoing generation
     * @param {WebSocket} ws
     */
    async #handleStopCommand(ws) {
        if (!this.#headlessInitialized) {
            this.#sendError(ws, 'Headless browser not ready');
            return;
        }

        try {
            await headlessBrowser.stopGeneration();
            this.#send(ws, { type: 'chunk', text: 'Generation stopped' });
            this.#send(ws, { type: 'end' });
        } catch (error) {
            this.#sendError(ws, `Stop error: ${error.message}`);
        }
    }

    /**
     * Handle generate command - calls the chat-completions endpoint and streams response
     * This is the low-level API bypass, use 'message' for full ST integration
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
        let fullText = '';

        try {
            while (true) {
                const { done, value } = await reader.read();

                if (done) {
                    this.#send(ws, { type: 'end', fullText });
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
                            this.#send(ws, { type: 'end', fullText });
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
                                fullText += content;
                                this.#send(ws, { type: 'chunk', text: content });
                            }
                        } catch {
                            // Non-JSON data line, might be a raw text chunk
                            if (data.trim()) {
                                fullText += data;
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
    async dispose() {
        if (this.#pingInterval) {
            clearInterval(this.#pingInterval);
        }

        // Dispose headless browser
        if (this.#headlessInitialized) {
            await headlessBrowser.dispose();
            this.#headlessInitialized = false;
        }

        this.#wss?.close();
    }
}

// Singleton instance
export const voiceWs = new VoiceWebSocketServer();
