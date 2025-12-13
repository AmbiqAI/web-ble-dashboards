// worker.js
let recordingSamples = []; 
const SAMPLE_RATE = 48000;

self.onmessage = function(e) {
    const { type, payload } = e.data;

    if (type === 'RECORD_CHUNK') {
        recordingSamples.push(payload); 
    }

    if (type === 'GENERATE_WAV') {
        if (recordingSamples.length === 0) return;
        let totalLength = recordingSamples.reduce((acc, curr) => acc + curr.length, 0);
        let flattened = new Float32Array(totalLength);
        let offset = 0;
        for (let chunk of recordingSamples) {
            flattened.set(chunk, offset);
            offset += chunk.length;
        }
        const blob = exportWav(flattened);
        self.postMessage({ type: 'WAV_BLOB', blob: blob });
    }
};

function exportWav(samples) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeString = (v, o, s) => { for (let i=0; i<s.length; i++) v.setUint8(o+i, s.charCodeAt(i)); };

    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // Mono
    view.setUint32(24, SAMPLE_RATE, true);
    view.setUint32(28, SAMPLE_RATE * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, samples.length * 2, true);

    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
        let s = Math.max(-1, Math.min(1, samples[i]));
        view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return new Blob([buffer], { type: 'audio/wav' });
}