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

        this.#browser = await puppeteer.launch({
            headless: this.#headless,
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

        // Additional wait for any async initialization
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    /**
     * Check if a character is selected
     * @returns {Promise<boolean>}
     */
    async hasCharacterSelected() {
        return this.#page.evaluate(() => {
            // @ts-ignore - this_chid is a global in ST
            return typeof this_chid !== 'undefined' && this_chid !== null && this_chid !== undefined;
        });
    }

    /**
     * Get the current character name
     * @returns {Promise<string|null>}
     */
    async getCurrentCharacter() {
        return this.#page.evaluate(() => {
            // @ts-ignore - name2 is a global in ST
            return typeof name2 !== 'undefined' ? name2 : null;
        });
    }

    /**
     * Get list of available characters
     * @returns {Promise<Array<{name: string, avatar: string}>>}
     */
    async getCharacterList() {
        return this.#page.evaluate(() => {
            // @ts-ignore - characters is a global in ST
            if (typeof characters === 'undefined') return [];
            return characters.map(c => ({
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
            // @ts-ignore - characters and selectCharacterById are globals in ST
            if (typeof characters === 'undefined' || typeof selectCharacterById === 'undefined') {
                return { success: false, error: 'ST not ready' };
            }

            const charIndex = characters.findIndex(c =>
                c.name.toLowerCase() === name.toLowerCase() ||
                c.avatar.toLowerCase().includes(name.toLowerCase()),
            );

            if (charIndex === -1) {
                return { success: false, error: `Character "${name}" not found` };
            }

            try {
                await selectCharacterById(String(charIndex));
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

        // Set the message text and trigger generation
        await this.#page.evaluate((msg) => {
            const textarea = document.querySelector('#send_textarea');
            if (textarea) {
                // @ts-ignore
                textarea.value = msg;
                textarea.dispatchEvent(new Event('input', { bubbles: true }));
            }
        }, message);

        // Trigger the send
        await this.#page.evaluate(() => {
            // @ts-ignore - sendTextareaMessage is exported from script.js
            if (typeof sendTextareaMessage === 'function') {
                sendTextareaMessage();
            } else {
                // Fallback: click the send button
                const sendBtn = document.querySelector('#send_but');
                if (sendBtn) {
                    // @ts-ignore
                    sendBtn.click();
                }
            }
        });

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
            let generationEnded = false;

            // Track the initial chat length
            this.#page.evaluate(() => {
                // @ts-ignore
                return typeof chat !== 'undefined' ? chat.length : 0;
            }).then(initialLength => {
                lastMessageIndex = initialLength;
            });

            // Set up event listener for generation end in the page
            this.#page.evaluate(() => {
                // @ts-ignore - eventSource is a global in ST
                if (typeof eventSource !== 'undefined' && typeof event_types !== 'undefined') {
                    // @ts-ignore
                    window.__voiceGenerationEnded = false;
                    const handler = () => {
                        // @ts-ignore
                        window.__voiceGenerationEnded = true;
                        // @ts-ignore
                        eventSource.removeListener(event_types.GENERATION_ENDED, handler);
                    };
                    // @ts-ignore
                    eventSource.once(event_types.GENERATION_ENDED, handler);
                }
            }).catch(() => {});

            // Poll for new content
            checkInterval = setInterval(async () => {
                try {
                    const state = await this.#page.evaluate((lastIdx) => {
                        // @ts-ignore - chat, is_send_press are globals
                        const currentChat = typeof chat !== 'undefined' ? chat : [];
                        const isGenerating = typeof is_send_press !== 'undefined' && is_send_press;
                        // @ts-ignore
                        const ended = window.__voiceGenerationEnded === true;

                        // Get the latest assistant message
                        let latestText = '';
                        if (currentChat.length > lastIdx) {
                            const lastMsg = currentChat[currentChat.length - 1];
                            if (!lastMsg.is_user && !lastMsg.is_system) {
                                latestText = lastMsg.mes || '';
                            }
                        }

                        // Also check the streaming element for real-time content
                        const streamingEl = document.querySelector('#chat .last_mes .mes_text');
                        if (streamingEl) {
                            const streamText = streamingEl.textContent || '';
                            if (streamText.length > latestText.length) {
                                latestText = streamText;
                            }
                        }

                        return {
                            isGenerating,
                            generationEnded: ended,
                            text: latestText,
                            chatLength: currentChat.length,
                        };
                    }, lastMessageIndex);

                    // Emit new chunks
                    if (state.text.length > fullText.length) {
                        const newContent = state.text.substring(fullText.length);
                        fullText = state.text;
                        if (onChunk) {
                            onChunk(newContent);
                        }
                        this.emit('chunk', newContent);
                    }

                    // Check if generation is complete (using event or is_send_press flag)
                    if ((state.generationEnded || !state.isGenerating) && state.chatLength > lastMessageIndex && fullText.length > 0) {
                        // Wait a tiny bit for any final content to settle
                        await new Promise(r => setTimeout(r, 100));

                        // Get final text from chat array (most reliable)
                        const finalText = await this.#page.evaluate((lastIdx) => {
                            // @ts-ignore
                            const currentChat = typeof chat !== 'undefined' ? chat : [];
                            if (currentChat.length > lastIdx) {
                                const lastMsg = currentChat[currentChat.length - 1];
                                if (!lastMsg.is_user && !lastMsg.is_system) {
                                    return lastMsg.mes || '';
                                }
                            }
                            return '';
                        }, lastMessageIndex);

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
            }, 100);

            // Timeout after configured duration
            timeoutId = setTimeout(() => {
                cleanup();
                resolve({
                    text: fullText,
                    success: fullText.length > 0,
                    error: fullText.length > 0 ? undefined : 'Generation timed out',
                });
            }, this.#timeout * 2); // Double timeout for generation

            const cleanup = () => {
                if (checkInterval) clearInterval(checkInterval);
                if (timeoutId) clearTimeout(timeoutId);
                // Clean up the flag
                this.#page.evaluate(() => {
                    // @ts-ignore
                    delete window.__voiceGenerationEnded;
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
            // @ts-ignore - stopGeneration is a global in ST
            if (typeof stopGeneration === 'function') {
                stopGeneration();
            }
        });
    }

    /**
     * Get the current chat history
     * @returns {Promise<Array<{is_user: boolean, mes: string, name: string}>>}
     */
    async getChatHistory() {
        return this.#page.evaluate(() => {
            // @ts-ignore - chat is a global in ST
            if (typeof chat === 'undefined') return [];
            return chat.map(m => ({
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
            // @ts-ignore - clearChat is a global in ST
            if (typeof clearChat === 'function') {
                clearChat();
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
