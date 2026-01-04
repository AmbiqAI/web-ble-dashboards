let audioChunks = [];
let recordingActive = false;

onmessage = function(e) {
    if (e.data.type === 'START_RECORDING') {
        audioChunks = []; // Reset the buffer for a fresh recording
        recordingActive = true;
    } 

    if (e.data.type === 'PROCESS_CHUNK') {
        // Only push to buffer if recording is active
        if (recordingActive) {
            audioChunks.push(new Float32Array(e.data.payload));
        }
    }
    
    if (e.data.type === 'GENERATE_WAV') {
        recordingActive = false; 
        if (audioChunks.length === 0) {
            console.warn("No audio recorded.");
            return;
        }
        const blob = exportWAV(audioChunks, 48000);
        postMessage({ type: 'WAV_BLOB', blob: blob });
        audioChunks = []; // Clear memory after export
    }
};

function exportWAV(chunks, sampleRate) {
    const totalSamples = chunks.length * 960;
    const flat = new Float32Array(totalSamples);
    for (let i = 0; i < chunks.length; i++) {
        flat.set(chunks[i], i * 960);
    }

    const buffer = new ArrayBuffer(44 + flat.length * 2);
    const view = new DataView(buffer);

    // RIFF Header
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + flat.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM Mono
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, flat.length * 2, true);

    let offset = 44;
    for (let i = 0; i < flat.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, flat[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([view], { type: 'audio/wav' });
}

function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
        view.setUint8(offset + i, string.charCodeAt(i));
    }
}