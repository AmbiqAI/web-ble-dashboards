// CRC32 implementation
function calcCrc32(init, length, data) {
    let crc = init >>> 0; // Ensure unsigned 32-bit
    for (let i = 0; i < length; i++) {
        crc ^= data[i];
        for (let j = 0; j < 8; j++) {
            crc = (crc >>> 1) ^ (0xEDB88320 & -(crc & 1));
        }
    }
    return crc >>> 0; // Return as unsigned 32-bit
}