/****************************************************************************************
 *
 * @file serial.js
 *
 * @brief WebUSB interface
 *
 * Copyright (C) Ambiq Micro
 *
 *
 ****************************************************************************************
 */

var serial = {};

(function() {
'use strict';

serial.getPorts = function() {
    return navigator.usb.getDevices().then(devices => {
        return devices.map(device => new serial.Port(device));
    });
};

serial.requestPort =
    function() {
    const filters = [
        {'vendorId' : 0xcafe}, // TinyUSB
    ];
    return navigator.usb.requestDevice({'filters' : filters})
        .then(device => new serial.Port(device));
}

    serial.Port = function(device) {
    this.device_         = device;
    this.interfaceNumber = 0;
    this.endpointIn      = 0;
    this.endpointOut     = 0;
};

serial.Port.prototype.connect = function() {
    console.log('Connecting');
    let readLoop = () => {
        // The max size of buffer is 512 bytes in AP5 high-speed mode.
        this.device_.transferIn(this.endpointIn, 512)
            .then(
                result => {
                    this.onReceive(result.data);
                    readLoop();
                },
                error => {
                    this.onReceiveError(error);
                });
    };

    return this.device_.open()
        .then(() => {
            if (this.device_.configuration === null)
            {
                return this.device_.selectConfiguration(1);
            }
        })
        .then(() => {
            var interfaces = this.device_.configuration.interfaces;
            interfaces.forEach(
                element => {element.alternates.forEach(elementalt => {
                    if (elementalt.interfaceClass == 0xFF)
                    {
                        this.interfaceNumber = element.interfaceNumber;
                        elementalt.endpoints.forEach(elementendpoint => {
                            if (elementendpoint.direction == "out")
                            {
                                this.endpointOut =
                                    elementendpoint.endpointNumber;
                            }
                            if (elementendpoint.direction == "in")
                            {
                                this.endpointIn =
                                    elementendpoint.endpointNumber;
                            }
                        })
                    }
                })})
        })
        .then(() => this.device_.claimInterface(this.interfaceNumber))
        .then(() => this.device_.selectAlternateInterface(this.interfaceNumber,
                                                          0))
        .then(() => this.device_.controlTransferOut({
            'requestType' : 'class',
            'recipient' : 'interface',
            'request' : 0x22,
            'value' : 0x01,
            'index' : this.interfaceNumber
        }))
        .then(() => {
            console.log('Connected');
            readLoop();
        });
};

serial.Port.prototype.disconnect = function() {
    return this.device_
        .controlTransferOut({
            'requestType' : 'class',
            'recipient' : 'interface',
            'request' : 0x22,
            'value' : 0x00,
            'index' : this.interfaceNumber
        })
        .then(() => this.device_.close());
};

serial.Port.prototype.send = function(data) {
    return this.device_.transferOut(this.endpointOut, data);
};

// Helper: CRC32 (reuse your crc32.js or use a simple implementation)
function crc32(buf) {
    // Use the calcCrc32 function from crc32.js
    return calcCrc32(0xFFFFFFFF, buf.length, buf);
}

// Helper: Wait for ACK
serial.Port.prototype.waitForAck = function(expectedChunk, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
        let timeout = setTimeout(() => reject('ACK timeout'), timeoutMs);
        const originalOnReceive = this.onReceive;
        this.onReceive = (data) => {
            if (data && data.byteLength === 5) {
                const dataArray = new Uint8Array(data.buffer);
                if (dataArray[0] === 0xAA) {
                    // Parse chunk_id from bytes 1-4 (LE)
                    const ackChunkId = dataArray[1] | (dataArray[2] << 8) | (dataArray[3] << 16) | (dataArray[4] << 24);
                    if (ackChunkId === expectedChunk) {
                        clearTimeout(timeout);
                        this.onReceive = originalOnReceive;
                        resolve();
                        return;
                    }
                }
            }
            if (originalOnReceive) {
                originalOnReceive(data);
            }
        };
    });
};

// Send model configuration with 13-byte header
serial.Port.prototype.sendModelConfig = async function(modelLocation, arenaLocation) {
    const configPayload = new Uint8Array([modelLocation, arenaLocation]);
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0, true); // CRC32 not needed for config
    view.setUint8(4, 3); // CHUNK_CMD_CONFIG
    view.setUint32(5, 0, true); // chunk_id = 0
    view.setUint32(9, 1, true); // total_chunks = 1

    const packet = new Uint8Array(header.length + configPayload.length);
    packet.set(header, 0);
    packet.set(configPayload, header.length);

    // Add 2-byte frame header for raw data (RX_RAW_DATA = 2)
    const frameHeader = new Uint8Array([0x00, 0x02]);
    const fullPacket = new Uint8Array(frameHeader.length + packet.length);
    fullPacket.set(frameHeader, 0);
    fullPacket.set(packet, frameHeader.length);

    await this.send(fullPacket);
};

// Request performance stats from the firmware
serial.Port.prototype.requestStats = async function() {
    console.log('Requesting performance stats from firmware...');
    
    // Create a 13-byte header with command = 4 (CHUNK_CMD_RUN_STATS)
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0, true); // CRC32 not needed for stats request
    view.setUint8(4, 4); // CHUNK_CMD_RUN_STATS
    view.setUint32(5, 0, true); // chunk_id = 0
    view.setUint32(9, 1, true); // total_chunks = 1

    // Add 2-byte frame header for raw data (RX_RAW_DATA = 2)
    const frameHeader = new Uint8Array([0x00, 0x02]);
    const packet = new Uint8Array(frameHeader.length + header.length);
    packet.set(frameHeader, 0);
    packet.set(header, frameHeader.length);

    console.log('Sending stats request packet:', Array.from(packet).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));

    // Return a Promise that waits for the stats response
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Stats request timeout'));
        }, 100000); // 10 second timeout

        const originalOnReceive = this.onReceive;
        this.onReceive = (data) => {
            console.log('Stats response received:', data.byteLength, 'bytes');
            if (data && data.byteLength > 0) {
                const dataArray = new Uint8Array(data.buffer);
                console.log('Stats response data:', Array.from(dataArray).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
                
                if (data.byteLength === 8) {
                    // This is the expected stats response (8 bytes: 4 bytes cycles + 4 bytes status)
                    const view = new DataView(data.buffer);
                    const cycles = view.getUint32(0, true); // Little-endian
                    const status = view.getUint32(4, true); // Little-endian
                    
                    console.log('Parsed stats response:', { cycles, status });
                    
                    clearTimeout(timeout);
                    this.onReceive = originalOnReceive;
                    resolve({ cycles, status });
                    return;
                } else if (data.byteLength === 5) {
                    // Check if this is a "RECV" message (which might indicate the command was received)
                    const message = new TextDecoder().decode(dataArray);
                    if (message === 'RECV') {
                        console.log('Received RECV confirmation, waiting for stats...');
                        // Don't resolve yet, wait for the actual stats
                        return;
                    }
                }
            }
            
            // Pass through to original handler for other data
            if (originalOnReceive) {
                originalOnReceive(data);
            }
        };

        // Send the request
        this.send(packet).catch(reject);
    });
};

// Main upload function
serial.Port.prototype.uploadModel = async function(file, modelLocation, arenaLocation, onProgress, onError, onComplete) {
    // First, send the model configuration
    try {
        console.log('Sending model configuration before upload...');
        console.log('Model location:', modelLocation === 0 ? 'TCM' : 'SRAM');
        console.log('Arena location:', arenaLocation === 0 ? 'TCM' : 'SRAM');
        await this.sendModelConfig(modelLocation, arenaLocation);
        
        // Wait a moment for the configuration to be processed
        await new Promise(resolve => setTimeout(resolve, 100));
        
        console.log('Configuration sent, starting model upload...');
    } catch (error) {
        console.error('Failed to send configuration:', error);
        if (onError) onError('Configuration failed: ' + error.message);
        return;
    }

    // USB transfer limit is 512 bytes, but we need space for frame header (2) + packet header (7)
    // So maximum chunk data size = 512 - 2 - 7 = 503 bytes
    const chunkSize = 480; // Conservative size to ensure we stay under USB limit
    const fileBuf = new Uint8Array(await file.arrayBuffer());
    const totalChunks = Math.ceil(fileBuf.length / chunkSize);
    let retries = 0;
    let maxRetries = 5;
    
    console.log(`Starting upload: ${fileBuf.length} bytes, ${totalChunks} chunks (${chunkSize} bytes per chunk)`);
    
    for (let chunkNum = 0; chunkNum < totalChunks; chunkNum++) {
        let sent = false;
        let chunkStart = chunkNum * chunkSize;
        let chunkEnd = Math.min(chunkStart + chunkSize, fileBuf.length);
        let chunkData = fileBuf.slice(chunkStart, chunkEnd);
        
        // Calculate CRC32
        let calculatedCrc = crc32(chunkData);
        console.log(`Chunk ${chunkNum}: size=${chunkData.length}, CRC32=0x${(calculatedCrc >>> 0).toString(16).padStart(8, '0')}`);
        
        // Debug: Show first few bytes of chunk data
        console.log(`Chunk data (first 8 bytes):`, Array.from(chunkData.slice(0, 8)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
        
        // Create header (13 bytes)
        let header = new Uint8Array(13);
        let view = new DataView(header.buffer);
        view.setUint32(0, calculatedCrc, true); // CRC32 LE
        view.setUint8(4, 1); // chunk command: 1=MODEL_CHUNK
        view.setUint32(5, chunkNum, true); // chunk_id as uint32_t, LE
        view.setUint32(9, totalChunks, true); // total_chunks as uint32_t, LE
        
        console.log(`Header: CRC32=0x${(calculatedCrc >>> 0).toString(16).padStart(8, '0')}, cmd=1, chunk=${chunkNum}, total=${totalChunks}`);
        
        // Debug: Show header bytes
        console.log(`Header bytes:`, Array.from(header).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
        
        // Combine header and chunk data
        let packet = new Uint8Array(header.length + chunkData.length);
        packet.set(header, 0);
        packet.set(chunkData, header.length);
        
        // Add 2-byte frame header for raw data (RX_RAW_DATA = 2)
        const frameHeader = new Uint8Array([0x00, 0x02]); // RX_RAW_DATA = 2, big-endian (high byte first)
        const fullPacket = new Uint8Array(frameHeader.length + packet.length);
        fullPacket.set(frameHeader, 0);
        fullPacket.set(packet, frameHeader.length);
        
        console.log(`Sending packet with frame header: ${fullPacket.length} bytes total`);
        console.log(`Frame header: 0x${frameHeader[0].toString(16).padStart(2, '0')} 0x${frameHeader[1].toString(16).padStart(2, '0')}, Packet: ${packet.length} bytes`);
        
        // Log the first few bytes of the packet for debugging
        console.log(`Packet header (first 10 bytes):`, Array.from(fullPacket.slice(0, 10)).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
        
        // Handshake loop
        retries = 0;
        while (!sent && retries < maxRetries) {
            try {
                console.log(`Attempt ${retries + 1}: Sending chunk ${chunkNum}`);
                await this.send(fullPacket);
                console.log(`Chunk ${chunkNum} sent, waiting for ACK...`);
                await this.waitForAck(chunkNum, 2000);
                console.log(`Chunk ${chunkNum} ACK received successfully`);
                sent = true;
            } catch (e) {
                retries++;
                console.log(`Chunk ${chunkNum} attempt ${retries} failed: ${e}`);
                if (retries >= maxRetries) {
                    console.error(`Chunk ${chunkNum} failed after ${maxRetries} retries: ${e}`);
                    if (onError) onError(`Chunk ${chunkNum} failed after ${maxRetries} retries.`);
                    return;
                }
            }
        }
        if (onProgress) onProgress(((chunkNum + 1) / totalChunks) * 100);
    }
    console.log('Upload completed successfully');
    if (onComplete) onComplete();
};
})();