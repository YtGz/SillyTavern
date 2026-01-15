import { saveTtsProviderSettings } from './index.js';
import { event_types, eventSource, getRequestHeaders } from '/script.js';
import { SECRET_KEYS, secret_state, writeSecret } from '/scripts/secrets.js';
export { FishAudioTtsProvider };

class FishAudioTtsProvider {
    settings;
    voices = [];
    separator = ' ... ';

    defaultSettings = {
        voiceMap: {},
        customVoices: '',
        model: 's1',
        format: 'mp3',
        latency: 'normal',
        chunkLength: 200,
    };

    get settingsHtml() {
        let html = `
        <div class="fishaudio_tts_settings">
            <div class="flex-container alignItemsBaseline">
                <h4 for="fishaudio_tts_key" class="flex1 margin0">
                    <a href="https://fish.audio/go-api/" target="_blank">Fish Audio API Key</a>
                </h4>
                <div id="fishaudio_tts_key" class="menu_button menu_button_icon manage-api-keys" data-key="api_key_fish_audio">
                    <i class="fa-solid fa-key"></i>
                    <span>Click to set</span>
                </div>
            </div>
            <label for="fishaudio_tts_model">Model</label>
            <select id="fishaudio_tts_model" class="text_pole">
                <option value="s1">S1 (Latest, Best Quality)</option>
                <option value="speech-1.6">Speech 1.6 (Stable)</option>
                <option value="speech-1.5">Speech 1.5 (Legacy)</option>
            </select>
            <label for="fishaudio_tts_format">Audio Format</label>
            <select id="fishaudio_tts_format" class="text_pole">
                <option value="mp3">MP3</option>
                <option value="wav">WAV</option>
                <option value="opus">Opus</option>
                <option value="pcm">PCM</option>
            </select>
            <label for="fishaudio_tts_latency">Latency Mode</label>
            <select id="fishaudio_tts_latency" class="text_pole">
                <option value="normal">Normal (Best Quality)</option>
                <option value="balanced">Balanced (Faster)</option>
            </select>
            <label for="fishaudio_tts_chunk_length">Chunk Length: <span id="fishaudio_tts_chunk_length_output"></span></label>
            <input id="fishaudio_tts_chunk_length" type="range" value="${this.defaultSettings.chunkLength}" min="100" max="300" step="10" />
            <hr>
            <label for="fishaudio_tts_custom_voices">Custom Voices</label>
            <textarea id="fishaudio_tts_custom_voices" class="text_pole" rows="3" placeholder="MyVoice=802e3bc2b27e49c2995d23ef70e6ac89&#10;Another Voice=abc123..."></textarea>
            <span>
                <small>
                    Add custom voices as <code>Name=reference_id</code>, one per line.
                    Browse voices at <a href="https://fish.audio/" target="_blank">fish.audio</a> and copy the model ID from the URL.
                </small>
            </span>
        </div>
        `;
        return html;
    }

    constructor() {
        this.handler = async function (/** @type {string} */ key) {
            if (key !== SECRET_KEYS.FISH_AUDIO) return;
            $('#fishaudio_tts_key').toggleClass('success', !!secret_state[SECRET_KEYS.FISH_AUDIO]);
            await this.fetchTtsVoiceObjects();
        }.bind(this);
    }

    dispose() {
        [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED].forEach(event => {
            eventSource.removeListener(event, this.handler);
        });
    }

    onSettingsChange() {
        this.settings.model = $('#fishaudio_tts_model').find(':selected').val();
        this.settings.format = $('#fishaudio_tts_format').find(':selected').val();
        this.settings.latency = $('#fishaudio_tts_latency').find(':selected').val();
        this.settings.chunkLength = Number($('#fishaudio_tts_chunk_length').val());
        this.settings.customVoices = String($('#fishaudio_tts_custom_voices').val());
        $('#fishaudio_tts_chunk_length_output').text(this.settings.chunkLength);
        this.parseCustomVoices();
        saveTtsProviderSettings();
    }

    async loadSettings(settings) {
        if (Object.keys(settings).length == 0) {
            console.info('Using default Fish Audio TTS Provider settings');
        }

        this.settings = this.defaultSettings;

        for (const key in settings) {
            if (key in this.settings) {
                this.settings[key] = settings[key];
            } else {
                throw `Invalid setting passed to TTS Provider: ${key}`;
            }
        }

        $('#fishaudio_tts_key').toggleClass('success', !!secret_state[SECRET_KEYS.FISH_AUDIO]);
        [event_types.SECRET_WRITTEN, event_types.SECRET_DELETED, event_types.SECRET_ROTATED].forEach(event => {
            eventSource.on(event, this.handler);
        });

        $('#fishaudio_tts_model').val(this.settings.model);
        $('#fishaudio_tts_format').val(this.settings.format);
        $('#fishaudio_tts_latency').val(this.settings.latency);
        $('#fishaudio_tts_chunk_length').val(this.settings.chunkLength);
        $('#fishaudio_tts_chunk_length_output').text(this.settings.chunkLength);
        $('#fishaudio_tts_custom_voices').val(this.settings.customVoices);

        $('#fishaudio_tts_model').on('change', this.onSettingsChange.bind(this));
        $('#fishaudio_tts_format').on('change', this.onSettingsChange.bind(this));
        $('#fishaudio_tts_latency').on('change', this.onSettingsChange.bind(this));
        $('#fishaudio_tts_chunk_length').on('input', this.onSettingsChange.bind(this));
        $('#fishaudio_tts_custom_voices').on('input', this.onSettingsChange.bind(this));

        try {
            await this.checkReady();
            console.debug('Fish Audio: Settings loaded');
        } catch {
            console.debug('Fish Audio: Settings loaded, but not ready');
        }
    }

    async checkReady() {
        await this.fetchTtsVoiceObjects();
    }

    async onRefreshClick() {
        await this.fetchTtsVoiceObjects();
    }

    /**
     * Get voice object by name
     * @param {string} voiceName Voice name to look up
     * @returns {Promise<Object>} Voice object
     */
    async getVoice(voiceName) {
        if (this.voices.length == 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }
        const match = this.voices.filter(
            voice => voice.name == voiceName,
        )[0];
        if (!match) {
            throw `TTS Voice name ${voiceName} not found in Fish Audio voices`;
        }
        return match;
    }

    /**
     * Generate TTS audio
     * @param {string} text Text to synthesize
     * @param {string} voiceId Voice ID to use for synthesis
     * @returns {Promise<Response>} Response object containing audio data
     */
    async generateTts(text, voiceId) {
        const response = await this.fetchTtsGeneration(text, voiceId);
        return response;
    }

    /**
     * Fetch new TTS generation from Fish Audio API
     * @param {string} text Text to synthesize
     * @param {string} voiceId Voice ID (reference_id) to use for synthesis
     * @returns {Promise<Response>} Response object containing audio data
     */
    async fetchTtsGeneration(text, voiceId) {
        console.info(`Fish Audio: Generating TTS for voice ${voiceId}`);
        const response = await fetch('/api/speech/fishaudio/synthesize', {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify({
                text: text,
                reference_id: voiceId,
                model: this.settings.model,
                format: this.settings.format,
                latency: this.settings.latency,
                chunk_length: this.settings.chunkLength,
            }),
        });
        if (!response.ok) {
            toastr.error(response.statusText, 'TTS Generation Failed');
            throw new Error(`HTTP ${response.status}. See server console for details.`);
        }
        return response;
    }

    /**
     * Parse custom voices from settings textarea
     */
    parseCustomVoices() {
        const customVoices = [];
        const lines = this.settings.customVoices.split('\n');
        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || !trimmed.includes('=')) continue;
            const [name, ...rest] = trimmed.split('=');
            const voiceId = rest.join('=').trim();
            if (name && voiceId) {
                customVoices.push({
                    name: name.trim(),
                    voice_id: voiceId,
                    lang: 'en',
                    preview_url: null,
                });
            }
        }
        this.voices = customVoices;
    }

    /**
     * Fetch available voice objects from custom voices setting
     * @returns {Promise<Array>} Array of voice objects
     */
    async fetchTtsVoiceObjects() {
        this.parseCustomVoices();
        return this.voices;
    }
}
