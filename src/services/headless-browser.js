import puppeteer from 'puppeteer';
import { EventEmitter } from 'node:events';

/**
 * @typedef {Object} HeadlessBrowserOptions
 * @property {string} [baseUrl='http://127.0.0.1:8000'] - SillyTavern base URL
 * @property {boolean} [headless=true] - Run browser in headless mode
 * @property {number} [timeout=30000] - Default timeout for operations
 */

/**
 * @typedef {Object} GenerationResult
 * @property {string} text - The complete generated text
 * @property {boolean} success - Whether generation succeeded
 * @property {string} [error] - Error message if failed
 */

/**
 * HeadlessBrowser wraps a Puppeteer instance running SillyTavern
 * to enable voice/external control of the full chat functionality.
 */
export class HeadlessBrowser extends EventEmitter {
    /** @type {import('puppeteer').Browser | null} */
    #browser = null;

    /** @type {import('puppeteer').Page | null} */
    #page = null;

    /** @type {boolean} */
    #initialized = false;

    /** @type {string} */
    #baseUrl;

    /** @type {boolean} */
    #headless;

    /** @type {number} */
    #timeout;

    /**
     * @param {HeadlessBrowserOptions} [options]
     */
    constructor(options = {}) {
        super();
        this.#baseUrl = options.baseUrl || 'http://127.0.0.1:8000';
        this.#headless = options.headless !== false;
        this.#timeout = options.timeout || 30000;
    }

    /**
     * Launch browser and navigate to SillyTavern
     * @returns {Promise<void>}
     */
    async initialize() {
        if (this.#initialized) {
            return;
        }

        console.log('[HeadlessBrowser] Launching browser...');

        // Use system Chromium if PUPPETEER_EXECUTABLE_PATH is set (Docker/Alpine)
        const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

        this.#browser = await puppeteer.launch({
            headless: this.#headless,
            executablePath,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1280,720',
            ],
        });

        this.#page = await this.#browser.newPage();

        // Set viewport
        await this.#page.setViewport({ width: 1280, height: 720 });

        // Log console messages from the page
        this.#page.on('console', (msg) => {
            const type = msg.type();
            if (type === 'error' || type === 'warning') {
                console.log(`[HeadlessBrowser][${type}] ${msg.text()}`);
            }
        });

        // Navigate to SillyTavern
        console.log(`[HeadlessBrowser] Navigating to ${this.#baseUrl}...`);
        await this.#page.goto(this.#baseUrl, {
            waitUntil: 'networkidle2',
            timeout: this.#timeout,
        });

        // Wait for SillyTavern to initialize (wait for character list or chat area)
        await this.#waitForSTReady();

        this.#initialized = true;
        console.log('[HeadlessBrowser] SillyTavern ready');
        this.emit('ready');
    }

    /**
     * Wait for SillyTavern UI to be ready
     * @returns {Promise<void>}
     */
    async #waitForSTReady() {
        await this.#page.waitForFunction(
            () => {
                // Check if SillyTavern's main script has loaded
                // @ts-ignore - window.SillyTavern is defined in the frontend
                return typeof window.SillyTavern !== 'undefined' ||
                       document.querySelector('#send_textarea') !== null;
            },
            { timeout: this.#timeout },
        );

        // Wait for characters to be loaded (they're fetched async on page load)
        await this.#page.waitForFunction(
            () => {
                // @ts-ignore - SillyTavern.getContext() is the proper API
                if (typeof SillyTavern === 'undefined' || typeof SillyTavern.getContext !== 'function') return false;
                const ctx = SillyTavern.getContext();
                return ctx.characters && ctx.characters.length > 0;
            },
            { timeout: this.#timeout },
        ).catch(() => {
            // Characters might not load if none exist - that's okay
            console.log('[HeadlessBrowser] No characters loaded (timeout or empty)');
        });

        // Additional wait for any async initialization
        await new Promise(resolve => setTimeout(resolve, 500));
    }

    /**
     * Check if a character is selected
     * @returns {Promise<boolean>}
     */
    async hasCharacterSelected() {
        return this.#page.evaluate(() => {
            // @ts-ignore - SillyTavern.getContext() is the proper API
            if (typeof SillyTavern === 'undefined') return false;
            const ctx = SillyTavern.getContext();
            return ctx.characterId !== undefined && ctx.characterId !== null;
        });
    }

    /**
     * Get the current character name
     * @returns {Promise<string|null>}
     */
    async getCurrentCharacter() {
        return this.#page.evaluate(() => {
            // @ts-ignore - SillyTavern.getContext() is the proper API
            if (typeof SillyTavern === 'undefined') return null;
            const ctx = SillyTavern.getContext();
            return ctx.name2 || null;
        });
    }

    /**
     * Get list of available characters
     * @returns {Promise<Array<{name: string, avatar: string}>>}
     */
    async getCharacterList() {
        return this.#page.evaluate(() => {
            // @ts-ignore - SillyTavern.getContext() is the proper API
            if (typeof SillyTavern === 'undefined') return [];
            const ctx = SillyTavern.getContext();
            if (!ctx.characters) return [];
            return ctx.characters.map(c => ({
                name: c.name,
                avatar: c.avatar,
            }));
        });
    }

    /**
     * Select a character by name
     * @param {string} characterName
     * @returns {Promise<boolean>}
     */
    async selectCharacter(characterName) {
        const result = await this.#page.evaluate(async (name) => {
            // @ts-ignore - SillyTavern.getContext() is the proper API
            if (typeof SillyTavern === 'undefined') {
                return { success: false, error: 'ST not ready' };
            }
            const ctx = SillyTavern.getContext();
            if (!ctx.characters || !ctx.selectCharacterById) {
                return { success: false, error: 'ST not ready' };
            }

            const charIndex = ctx.characters.findIndex(c =>
                c.name.toLowerCase() === name.toLowerCase() ||
                c.avatar.toLowerCase().includes(name.toLowerCase()),
            );

            if (charIndex === -1) {
                return { success: false, error: `Character "${name}" not found` };
            }

            try {
                await ctx.selectCharacterById(String(charIndex));
                return { success: true };
            } catch (e) {
                return { success: false, error: e.message };
            }
        }, characterName);

        if (!result.success) {
            console.error(`[HeadlessBrowser] Failed to select character: ${result.error}`);
        }

        return result.success;
    }

    /**
     * Send a message and get the streamed response
     * @param {string} message - User message to send
     * @param {(chunk: string) => void} [onChunk] - Callback for each response chunk
     * @returns {Promise<GenerationResult>}
     */
    async sendMessage(message, onChunk) {
        if (!this.#initialized) {
            throw new Error('HeadlessBrowser not initialized');
        }

        const hasChar = await this.hasCharacterSelected();
        if (!hasChar) {
            return {
                text: '',
                success: false,
                error: 'No character selected',
            };
        }

        console.log(`[HeadlessBrowser] Sending message: "${message.substring(0, 50)}${message.length > 50 ? '...' : ''}"`);

        // Set up response collection before triggering generation
        const responsePromise = this.#collectResponse(onChunk);

        // Set the message text in the textarea
        await this.#page.evaluate((msg) => {
            const textarea = document.querySelector('#send_textarea');
            if (textarea) {
                // @ts-ignore
                textarea.value = msg;
                // Dispatch input event to trigger any listeners
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, message);

        // Click the send button - this is the most reliable way to trigger generation
        // It properly adds the user message and triggers the AI response
        await this.#page.click('#send_but');

        // Wait for response
        const result = await responsePromise;
        return result;
    }

    /**
     * Collect the streaming response from generation
     * @param {(chunk: string) => void} [onChunk]
     * @returns {Promise<GenerationResult>}
     */
    async #collectResponse(onChunk) {
        return new Promise((resolve) => {
            let fullText = '';
            let lastMessageIndex = -1;
            let checkInterval;
            let timeoutId;

            // Track the initial chat length
            this.#page.evaluate(() => {
                // @ts-ignore - SillyTavern.getContext() is the proper API
                if (typeof SillyTavern === 'undefined') return 0;
                const ctx = SillyTavern.getContext();
                return ctx.chat ? ctx.chat.length : 0;
            }).then(initialLength => {
                lastMessageIndex = initialLength;
            });

            // Set up event listeners in the page for streaming and completion
            this.#page.evaluate(() => {
                // @ts-ignore
                window.__voiceStreamText = '';
                // @ts-ignore
                window.__voiceGenerationEnded = false;
                // @ts-ignore
                window.__voiceMessageReceived = false;

                // @ts-ignore - SillyTavern.getContext() is the proper API
                if (typeof SillyTavern === 'undefined') return;
                const ctx = SillyTavern.getContext();

                if (ctx.eventSource && ctx.eventTypes) {
                    // Listen for generation end
                    const endHandler = () => {
                        // @ts-ignore
                        window.__voiceGenerationEnded = true;
                        ctx.eventSource.removeListener(ctx.eventTypes.GENERATION_ENDED, endHandler);
                    };
                    ctx.eventSource.once(ctx.eventTypes.GENERATION_ENDED, endHandler);

                    // Listen for message received (contains the streamed text)
                    const msgHandler = (messageIndex) => {
                        // @ts-ignore
                        window.__voiceMessageReceived = true;
                        const chat = ctx.chat || [];
                        if (chat[messageIndex]) {
                            // @ts-ignore
                            window.__voiceStreamText = chat[messageIndex].mes || '';
                        }
                        ctx.eventSource.removeListener(ctx.eventTypes.MESSAGE_RECEIVED, msgHandler);
                    };
                    ctx.eventSource.once(ctx.eventTypes.MESSAGE_RECEIVED, msgHandler);
                }

                // Also set up a MutationObserver on the streaming text element
                const observer = new MutationObserver(() => {
                    const streamingEl = document.querySelector('#chat .last_mes .mes_text');
                    if (streamingEl) {
                        const text = streamingEl.textContent || '';
                        // Ignore placeholder text
                        if (text && text !== '...' && text !== '…') {
                            // @ts-ignore
                            window.__voiceStreamText = text;
                        }
                    }
                });

                // Start observing once a new message appears
                const checkForNewMessage = setInterval(() => {
                    const lastMes = document.querySelector('#chat .last_mes .mes_text');
                    if (lastMes) {
                        observer.observe(lastMes, { childList: true, characterData: true, subtree: true });
                        clearInterval(checkForNewMessage);
                        // Store observer for cleanup
                        // @ts-ignore
                        window.__voiceObserver = observer;
                    }
                }, 50);

                // Cleanup after 60 seconds max
                setTimeout(() => {
                    clearInterval(checkForNewMessage);
                    observer.disconnect();
                }, 60000);
            }).catch(() => {});

            // Poll for new content from the page
            checkInterval = setInterval(async () => {
                try {
                    const state = await this.#page.evaluate((lastIdx) => {
                        // @ts-ignore
                        const streamText = window.__voiceStreamText || '';
                        // @ts-ignore
                        const ended = window.__voiceGenerationEnded === true;
                        // @ts-ignore
                        const received = window.__voiceMessageReceived === true;

                        // Also check chat length
                        let chatLength = 0;
                        // @ts-ignore
                        if (typeof SillyTavern !== 'undefined') {
                            const ctx = SillyTavern.getContext();
                            chatLength = ctx.chat ? ctx.chat.length : 0;
                        }

                        return {
                            text: streamText,
                            generationEnded: ended,
                            messageReceived: received,
                            chatLength,
                        };
                    }, lastMessageIndex);

                    // Emit new chunks (skip placeholder)
                    if (state.text && state.text !== '...' && state.text !== '…' && state.text.length > fullText.length) {
                        const newContent = state.text.substring(fullText.length);
                        fullText = state.text;
                        if (onChunk) {
                            onChunk(newContent);
                        }
                        this.emit('chunk', newContent);
                    }

                    // Check if generation is complete
                    if (state.generationEnded && state.chatLength > lastMessageIndex) {
                        // Wait for final content to settle
                        await new Promise(r => setTimeout(r, 200));

                        // Get final text from chat array
                        const finalText = await this.#page.evaluate((lastIdx) => {
                            // @ts-ignore - SillyTavern.getContext() is the proper API
                            if (typeof SillyTavern === 'undefined') return '';
                            const ctx = SillyTavern.getContext();
                            const currentChat = ctx.chat || [];
                            if (currentChat.length > lastIdx) {
                                const lastMsg = currentChat[currentChat.length - 1];
                                if (!lastMsg.is_user && !lastMsg.is_system) {
                                    return lastMsg.mes || '';
                                }
                            }
                            return '';
                        }, lastMessageIndex);

                        // Emit any remaining content
                        if (finalText.length > fullText.length) {
                            const newContent = finalText.substring(fullText.length);
                            fullText = finalText;
                            if (onChunk) {
                                onChunk(newContent);
                            }
                            this.emit('chunk', newContent);
                        }

                        cleanup();
                        resolve({
                            text: fullText,
                            success: true,
                        });
                    }
                } catch (err) {
                    // Page might be navigating, ignore
                }
            }, 50); // Poll more frequently for smoother streaming

            // Timeout after configured duration
            timeoutId = setTimeout(() => {
                cleanup();
                resolve({
                    text: fullText,
                    success: fullText.length > 0,
                    error: fullText.length > 0 ? undefined : 'Generation timed out',
                });
            }, this.#timeout * 2);

            const cleanup = () => {
                if (checkInterval) clearInterval(checkInterval);
                if (timeoutId) clearTimeout(timeoutId);
                // Clean up page state
                this.#page.evaluate(() => {
                    // @ts-ignore
                    if (window.__voiceObserver) {
                        // @ts-ignore
                        window.__voiceObserver.disconnect();
                    }
                    // @ts-ignore
                    delete window.__voiceStreamText;
                    // @ts-ignore
                    delete window.__voiceGenerationEnded;
                    // @ts-ignore
                    delete window.__voiceMessageReceived;
                    // @ts-ignore
                    delete window.__voiceObserver;
                }).catch(() => {});
            };
        });
    }

    /**
     * Stop any ongoing generation
     * @returns {Promise<void>}
     */
    async stopGeneration() {
        await this.#page.evaluate(() => {
            // @ts-ignore - SillyTavern.getContext() is the proper API
            if (typeof SillyTavern === 'undefined') return;
            const ctx = SillyTavern.getContext();
            if (ctx.stopGeneration) {
                ctx.stopGeneration();
            }
        });
    }

    /**
     * Get the current chat history
     * @returns {Promise<Array<{is_user: boolean, mes: string, name: string}>>}
     */
    async getChatHistory() {
        return this.#page.evaluate(() => {
            // @ts-ignore - SillyTavern.getContext() is the proper API
            if (typeof SillyTavern === 'undefined') return [];
            const ctx = SillyTavern.getContext();
            if (!ctx.chat) return [];
            return ctx.chat.map(m => ({
                is_user: m.is_user,
                mes: m.mes,
                name: m.name,
            }));
        });
    }

    /**
     * Clear the current chat
     * @returns {Promise<void>}
     */
    async clearChat() {
        await this.#page.evaluate(() => {
            // @ts-ignore - SillyTavern.getContext() is the proper API
            if (typeof SillyTavern === 'undefined') return;
            const ctx = SillyTavern.getContext();
            if (ctx.clearChat) {
                ctx.clearChat();
            }
        });
    }

    /**
     * Take a screenshot (useful for debugging)
     * @param {string} [path] - File path to save screenshot
     * @returns {Promise<Buffer>}
     */
    async screenshot(path) {
        return this.#page.screenshot({ path, fullPage: true });
    }

    /**
     * Check if browser is initialized and ready
     * @returns {boolean}
     */
    get isReady() {
        return this.#initialized && this.#browser !== null && this.#page !== null;
    }

    /**
     * Close the browser
     * @returns {Promise<void>}
     */
    async dispose() {
        this.#initialized = false;

        if (this.#page) {
            await this.#page.close().catch(() => {});
            this.#page = null;
        }

        if (this.#browser) {
            await this.#browser.close().catch(() => {});
            this.#browser = null;
        }

        console.log('[HeadlessBrowser] Disposed');
        this.emit('disposed');
    }
}

// Singleton instance for voice WebSocket integration
export const headlessBrowser = new HeadlessBrowser();
