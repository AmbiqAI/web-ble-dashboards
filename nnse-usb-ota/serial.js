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
    this.listeners = [];
};

serial.Port.prototype.connect = function() {
    console.log('Connecting');
    let readLoop = () => {
        // The max size of buffer is 512 bytes in AP5 high-speed mode.
        this.device_.transferIn(this.endpointIn, 512)
            .then(
                result => {
                    this.handleReceive(result.data);
                    readLoop();
                },
                error => {
                    if (this.onReceiveError) this.onReceiveError(error);
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

serial.Port.prototype.handleReceive = function(data) {
    // Call all listeners, remove those that return true (handled)
    this.listeners = this.listeners.filter(listener => {
        try {
            return !listener(data);
        } catch (e) {
            console.error('Listener threw:', e);
            return false;
        }
    });
};

serial.Port.prototype.addListener = function(listener) {
    this.listeners.push(listener);
};

// Helper: Wait for ACK
serial.Port.prototype.waitForAck = function(expectedChunk, timeoutMs = 1000) {
    return new Promise((resolve, reject) => {
        let timeout = setTimeout(() => reject('ACK timeout'), timeoutMs);
        this.addListener((data) => {
            console.log('[ACK] Received data:', data.byteLength, 'bytes');
            if (data && data.byteLength > 0) {
                const dataArray = new Uint8Array(data.buffer);
                console.log('[ACK] Data bytes:', Array.from(dataArray).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
            }
            if (data && data.byteLength === 5) {
                const dataArray = new Uint8Array(data.buffer);
                if (dataArray[0] === 0xAA) {
                    const ackChunkId = dataArray[1] | (dataArray[2] << 8) | (dataArray[3] << 16) | (dataArray[4] << 24);
                    console.log('[ACK] Received ACK for chunk', ackChunkId, 'expected', expectedChunk);
                    if (ackChunkId === expectedChunk) {
                        clearTimeout(timeout);
                        resolve();
                        return true; // Remove this listener
                    }
                }
            }
            return false; // Keep this listener
        });
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
        }, 30000); // 30 second timeout

        this.addListener((data) => {
            console.log('Stats response received:', data.byteLength, 'bytes');
            if (data && data.byteLength > 0) {
                const dataArray = new Uint8Array(data.buffer);
                console.log('Stats response data:', Array.from(dataArray).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
                
                if (data.byteLength === 16) {
                    // This is the expected stats response (16 bytes: 4 bytes cycles + 4 bytes status + 4 bytes num_layers + 4 bytes arena_used)
                    const view = new DataView(data.buffer);
                    const cycles = view.getUint32(0, true); // Little-endian
                    const status = view.getUint32(4, true); // Little-endian
                    const num_layers = view.getUint32(8, true); // Little-endian
                    const arena_used = view.getUint32(12, true); // Little-endian
                    
                    console.log('Parsed stats response:', { cycles, status, num_layers, arena_used });
                    
                    clearTimeout(timeout);
                    resolve({ cycles, status, num_layers, arena_used });
                    return true; // Remove this listener
                } else if (data.byteLength === 8) {
                    // Legacy 8-byte response (for backward compatibility)
                    const view = new DataView(data.buffer);
                    const cycles = view.getUint32(0, true); // Little-endian
                    const status = view.getUint32(4, true); // Little-endian
                    
                    console.log('Parsed legacy stats response:', { cycles, status });
                    
                    clearTimeout(timeout);
                    resolve({ cycles, status, num_layers: 0, arena_used: 0 });
                    return true; // Remove this listener
                } else if (data.byteLength === 5) {
                    // Check if this is a "RECV" message (which might indicate the command was received)
                    const message = new TextDecoder().decode(dataArray);
                    if (message === 'RECV') {
                        console.log('Received RECV confirmation, waiting for stats...');
                        // Don't resolve yet, wait for the actual stats
                        return false; // Keep this listener
                    }
                }
            }
            
            // Pass through to original handler for other data
            return false; // Keep this listener
        });

        // Send the request
        this.send(packet).catch(reject);
    });
};

let pmuCsvRows = [];
let pmuCsvTotalChunks = null;
let pmuCsvExpectedChunk = 0;

let pmuCsvHeader = "Tag, uSeconds, ARM_PMU_SW_INCR,ARM_PMU_L1I_CACHE_REFILL,ARM_PMU_L1D_CACHE_REFILL,ARM_PMU_L1D_CACHE,ARM_PMU_LD_RETIRED,ARM_PMU_ST_RETIRED,ARM_PMU_INST_RETIRED,ARM_PMU_EXC_TAKEN,ARM_PMU_EXC_RETURN,ARM_PMU_PC_WRITE_RETIRED,ARM_PMU_BR_IMMED_RETIRED,ARM_PMU_BR_RETURN_RETIRED,ARM_PMU_UNALIGNED_LDST_RETIRED,ARM_PMU_CPU_CYCLES,ARM_PMU_MEM_ACCESS,ARM_PMU_L1I_CACHE,ARM_PMU_L1D_CACHE_WB,ARM_PMU_BUS_ACCESS,ARM_PMU_MEMORY_ERROR,ARM_PMU_BUS_CYCLES,ARM_PMU_CHAIN,ARM_PMU_L1D_CACHE_ALLOCATE,ARM_PMU_BR_RETIRED,ARM_PMU_BR_MIS_PRED_RETIRED,ARM_PMU_STALL_FRONTEND,ARM_PMU_STALL_BACKEND,ARM_PMU_LL_CACHE_RD,ARM_PMU_LL_CACHE_MISS_RD,ARM_PMU_L1D_CACHE_MISS_RD,ARM_PMU_STALL,ARM_PMU_L1D_CACHE_RD,ARM_PMU_LE_RETIRED,ARM_PMU_LE_CANCEL,ARM_PMU_SE_CALL_S,ARM_PMU_SE_CALL_NS,ARM_PMU_MVE_INST_RETIRED,ARM_PMU_MVE_FP_RETIRED,ARM_PMU_MVE_FP_HP_RETIRED,ARM_PMU_MVE_FP_SP_RETIRED,ARM_PMU_MVE_FP_MAC_RETIRED,ARM_PMU_MVE_INT_RETIRED,ARM_PMU_MVE_INT_MAC_RETIRED,ARM_PMU_MVE_LDST_RETIRED,ARM_PMU_MVE_LD_RETIRED,ARM_PMU_MVE_ST_RETIRED,ARM_PMU_MVE_LDST_CONTIG_RETIRED,ARM_PMU_MVE_LD_CONTIG_RETIRED,ARM_PMU_MVE_ST_CONTIG_RETIRED,ARM_PMU_MVE_LDST_NONCONTIG_RETIRED,ARM_PMU_MVE_LD_NONCONTIG_RETIRED,ARM_PMU_MVE_ST_NONCONTIG_RETIRED,ARM_PMU_MVE_LDST_MULTI_RETIRED,ARM_PMU_MVE_LD_MULTI_RETIRED,ARM_PMU_MVE_ST_MULTI_RETIRED,ARM_PMU_MVE_LDST_UNALIGNED_RETIRED,ARM_PMU_MVE_LD_UNALIGNED_RETIRED,ARM_PMU_MVE_ST_UNALIGNED_RETIRED,ARM_PMU_MVE_LDST_UNALIGNED_NONCONTIG_RETIRED,ARM_PMU_MVE_VREDUCE_RETIRED,ARM_PMU_MVE_VREDUCE_FP_RETIRED ,ARM_PMU_MVE_VREDUCE_INT_RETIRED,ARM_PMU_MVE_PRED,ARM_PMU_MVE_STALL,ARM_PMU_MVE_STALL_RESOURCE,ARM_PMU_MVE_STALL_RESOURCE_MEM ,ARM_PMU_MVE_STALL_RESOURCE_FP,ARM_PMU_MVE_STALL_RESOURCE_INT ,ARM_PMU_MVE_STALL_BREAK,ARM_PMU_MVE_STALL_DEPENDENCY,ARM_PMU_ITCM_ACCESS,ARM_PMU_DTCM_ACCESS";
serial.Port.prototype.requestPmuCsv = async function() {
    console.log('Requesting PMU CSV from firmware...');
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0, true);
    view.setUint8(4, 5); // CHUNK_CMD_PMU_CSV
    view.setUint32(5, 0, true);
    view.setUint32(9, 1, true);
    const frameHeader = new Uint8Array([0x00, 0x02]);
    const packet = new Uint8Array(frameHeader.length + header.length);
    packet.set(frameHeader, 0);
    packet.set(header, frameHeader.length);
    let pmuCsvRows = [];
    let pmuCsvTotalChunks = null;
    let pmuCsvExpectedChunk = 0;
    pmuCsvRows[0] = pmuCsvHeader;
    
    return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('PMU CSV request timeout'));
        }, 30000); // 30 second timeout
        
        this.addListener(((data) => {
            console.log('[PMU CSV Listener] Received data:', data, 'length:', data ? data.byteLength : 0);
            if (!data || data.byteLength < 13) return false;
            const dataArray = new Uint8Array(data.buffer);
            if (dataArray[0] !== 0x00 || dataArray[1] !== 0x02) return false;
            const view = new DataView(dataArray.buffer, dataArray.byteOffset + 2, 13);
            const command = view.getUint8(4);
            const chunk_id = view.getUint32(5, true);
            const total_chunks = view.getUint32(9, true);
            console.log('Received command:', command, 'chunk_id:', chunk_id, 'total_chunks:', total_chunks);
            if (command === 0x05) {
                const tag = new TextDecoder().decode(dataArray.subarray(15, 35));
                const elapsed_us = dataArray.subarray(35, 39);
                console.log('Tag:', tag, 'Elapsed us:', elapsed_us);
                const elapsed_us_view = new DataView(elapsed_us.buffer, elapsed_us.byteOffset, elapsed_us.byteLength);
                const elapsed_us_value = elapsed_us_view.getUint16(0, true);
                console.log('Elapsed us value:', elapsed_us_value);
                const payload = dataArray.subarray(39);
                const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
                const numU32 = payload.byteLength / 4;
                const values = [];

                // Add tag and elapsed_us to the values
                values.push(tag);
                values.push(elapsed_us_value);

                for (let i = 0; i < numU32; i++) {
                    values.push(view.getUint32(i * 4, true)); // little-endian
                    console.log(i+1, ' Value:', values[i+2]);
                }
                console.log(values);
                const csvRow = values.join(',');
                if (chunk_id === pmuCsvExpectedChunk) {
                    pmuCsvRows[chunk_id+1] = csvRow;
                    pmuCsvTotalChunks = total_chunks;
                    pmuCsvExpectedChunk++;
                }
                // Always ACK, even if duplicate
                console.log('Sending ACK for chunk', chunk_id);
                this.sendAck(chunk_id);
                if (
                    pmuCsvRows.length === pmuCsvTotalChunks+1 &&
                    pmuCsvRows.every(row => typeof row === 'string')
                ) {
                    const csvContent = pmuCsvRows.join('\n');
                    
                    // Save to localStorage
                    localStorage.setItem('pmuCsvData', csvContent);
                    console.log('PMU CSV data saved to localStorage');
                    
                    clearTimeout(timeout);
                    resolve({ csvContent, totalRows: pmuCsvRows.length - 1 });
                    return true; // Remove this listener
                }
            }
            return false;
        }).bind(this));
        
        // Send the request
        this.send(packet).catch(reject);
    });
};

serial.Port.prototype.sendAck = async function(chunk_id) {
    // 13-byte protocol header, like in uploadModel
    const header = new Uint8Array(13);
    const view = new DataView(header.buffer);
    view.setUint32(0, 0, true); // CRC32 not needed for ACK
    view.setUint8(4, 2); // CHUNK_CMD_ACK
    view.setUint32(5, chunk_id, true); // chunk_id as uint32_t, LE
    view.setUint32(9, 1, true); // total_chunks = 1

    // 2-byte frame header
    const frameHeader = new Uint8Array([0x00, 0x02]);
    const fullPacket = new Uint8Array(frameHeader.length + header.length);
    fullPacket.set(frameHeader, 0);
    fullPacket.set(header, frameHeader.length);
    console.log('[ACK] Sending ACK for chunk', chunk_id, Array.from(fullPacket).map(b => '0x' + b.toString(16).padStart(2, '0')).join(' '));
    await this.send(fullPacket);
};

// Download CSV from localStorage
serial.Port.prototype.downloadPmuCsvFromLocalStorage = async function() {
    console.log('Downloading PMU CSV from localStorage...');
    
    // Get CSV content from localStorage
    const csvContent = localStorage.getItem('pmuCsvData');
    if (!csvContent) {
        throw new Error('No PMU CSV data found in localStorage. Click "Get Performance Stats" first to collect data.');
    }
    
    console.log('CSV content found, length:', csvContent.length);
    
    // Download the CSV file
    const blob = new Blob([csvContent], {type: 'text/csv'});
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'pmu_stats.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    
    console.log('PMU CSV downloaded successfully');
    return { csvContent, totalRows: csvContent.split('\n').length - 1 };
};

// Helper function to get tensor shape as string
function getTensorShape(tensor) {
    if (!tensor || !tensor.shape) return 'unknown';
    const shape = [];
    for (let i = 0; i < tensor.shapeLength(); i++) {
        shape.push(tensor.shape(i));
    }
    return shape.join('x');
}

// Helper function to get tensor data type name
function getTensorTypeName(tensor) {
    const typeNames = [
        'FLOAT32', 'FLOAT16', 'INT32', 'UINT8', 'INT64', 'STRING', 'BOOL', 'INT16', 'COMPLEX64', 'INT8'
    ];
    return typeNames[tensor.type()] || 'UNKNOWN';
}

// Function to extract and log TFLM model attributes using TensorFlow.js
serial.Port.prototype.extractModelAttributes = async function(modelBuffer) {
    console.log('=== Extracting Model Attributes using TensorFlow.js ===');
    
    try {
        // Check if TensorFlow.js is available in the global scope
        if (typeof tf === 'undefined' || typeof tflite === 'undefined') {
            console.log('TensorFlow.js not available, falling back to flatbuffers approach...');
            await this.extractModelAttributesFlatbuffers(modelBuffer);
            return;
        }
        
        // Verify the model buffer
        if (!modelBuffer || modelBuffer.length === 0) {
            console.error('Error: Invalid model buffer');
            return;
        }
        
        // Create a Blob from the model buffer and load it with TensorFlow.js
        const modelBlob = new Blob([modelBuffer], { type: 'application/octet-stream' });
        const modelUrl = URL.createObjectURL(modelBlob);
        
        console.log('Loading model with TensorFlow.js...');
        let model;
        try {
            model = await tflite.loadTFLiteModel(modelUrl);
        } catch (loadError) {
            console.log('Failed to load model with TensorFlow.js:', loadError.message);
            console.log('Falling back to flatbuffers approach...');
            URL.revokeObjectURL(modelUrl);
            await this.extractModelAttributesFlatbuffers(modelBuffer);
            return;
        }
        
        // Get model signature (metadata)
        const signature = model.signature;
        console.log('Model Signature:', signature);
        
        // Get input and output details
        console.log('\n=== Model Inputs ===');
        if (signature.inputs) {
            Object.keys(signature.inputs).forEach(inputName => {
                const input = signature.inputs[inputName];
                console.log(`Input: ${inputName}`);
                console.log(`  Shape: ${input.shape.join('x')}`);
                console.log(`  Type: ${input.dtype}`);
                if (input.quantization) {
                    console.log(`  Quantization: scale=${input.quantization.scale}, zero_point=${input.quantization.zero_point}`);
                }
                console.log('');
            });
        }
        
        console.log('\n=== Model Outputs ===');
        if (signature.outputs) {
            Object.keys(signature.outputs).forEach(outputName => {
                const output = signature.outputs[outputName];
                console.log(`Output: ${outputName}`);
                console.log(`  Shape: ${output.shape.join('x')}`);
                console.log(`  Type: ${output.dtype}`);
                if (output.quantization) {
                    console.log(`  Quantization: scale=${output.quantization.scale}, zero_point=${output.quantization.zero_point}`);
                }
                console.log('');
            });
        }
        
        // Try to get model metadata
        console.log('\n=== Model Metadata ===');
        if (model.modelMetadata) {
            console.log('Model Metadata:', model.modelMetadata);
        }
        
        // Try to get model details from the internal representation
        console.log('\n=== Model Details ===');
        console.log('Full model object:', model);
        
        // Try different ways to access the model internals
        if (model.model) {
            const modelDetails = model.model;
            console.log('Model Details:', modelDetails);
            
            // Try to access operator information
            if (modelDetails.ops) {
                console.log('\n=== Operator Details ===');
                modelDetails.ops.forEach((op, index) => {
                    console.log(`Operator ${index}:`);
                    console.log(`  Type: ${op.op}`);
                    console.log(`  Inputs: ${op.inputs ? op.inputs.join(', ') : 'N/A'}`);
                    console.log(`  Outputs: ${op.outputs ? op.outputs.join(', ') : 'N/A'}`);
                    
                    // Try to get operator attributes
                    if (op.attrs) {
                        console.log('  Attributes:');
                        Object.keys(op.attrs).forEach(attrName => {
                            console.log(`    ${attrName}: ${JSON.stringify(op.attrs[attrName])}`);
                        });
                    }
                    console.log('');
                });
            }
        }
        
        // Try to access the model's internal graph
        if (model.graph) {
            console.log('\n=== Model Graph ===');
            console.log('Graph:', model.graph);
        }
        
        // Try to access the model's execution plan
        if (model.executionPlan) {
            console.log('\n=== Execution Plan ===');
            console.log('Execution Plan:', model.executionPlan);
        }
        
        // Try to get the model's metadata
        if (model.metadata) {
            console.log('\n=== Model Metadata ===');
            console.log('Metadata:', model.metadata);
        }
        
        // Try to access the model's internal representation
        console.log('\n=== Model Internal Properties ===');
        Object.keys(model).forEach(key => {
            console.log(`${key}:`, model[key]);
        });
        
        // Try alternative approach - convert to TensorFlow.js model
        console.log('\n=== Trying TensorFlow.js Model Conversion ===');
        try {
            // Try to get the model as a TensorFlow.js model
            const tfModel = await tf.loadGraphModel(modelUrl);
            console.log('TensorFlow.js Model:', tfModel);
            
            // Get model inputs and outputs
            const inputs = tfModel.inputs;
            const outputs = tfModel.outputs;
            
            console.log('Model Inputs:', inputs);
            console.log('Model Outputs:', outputs);
            
            // Try to get the model's graph
            if (tfModel.graph) {
                console.log('Model Graph:', tfModel.graph);
                
                // Try to access nodes in the graph
                if (tfModel.graph.nodes) {
                    console.log('\n=== Graph Nodes ===');
                    Object.keys(tfModel.graph.nodes).forEach(nodeName => {
                        const node = tfModel.graph.nodes[nodeName];
                        console.log(`Node: ${nodeName}`);
                        console.log('  Node details:', node);
                        
                        // Try to get node attributes
                        if (node.attr) {
                            console.log('  Attributes:');
                            Object.keys(node.attr).forEach(attrName => {
                                console.log(`    ${attrName}:`, node.attr[attrName]);
                            });
                        }
                        console.log('');
                    });
                }
            }
        } catch (conversionError) {
            console.log('TensorFlow.js conversion failed:', conversionError.message);
        }
        
        // Clean up the blob URL
        URL.revokeObjectURL(modelUrl);
        
        console.log('=== Model Attributes Extraction Complete ===');
        
    } catch (error) {
        console.error('Error extracting model attributes with TensorFlow.js:', error);
        
        // Fallback to flatbuffers approach if TensorFlow.js fails
        console.log('Falling back to flatbuffers approach...');
        await this.extractModelAttributesFlatbuffers(modelBuffer);
    }
    
    // Detailed operator attributes are now integrated into the main flatbuffers extraction above
};

// Function to extract detailed attributes for a single operator
serial.Port.prototype.extractOperatorAttributes = async function(op, opName, tflite, operatorIndex) {
    try {
        // Helper function to convert op name to PascalCase
        function toPascalCase(opName) {
            return opName
                .toLowerCase()
                .split('_')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join('');
        }
        
        // Helper function to get options class name
        function getOptionsClassName(opName) {
            return `${toPascalCase(opName)}Options`;
        }
        
        const optionsClassName = getOptionsClassName(opName);
        
        // Check if this operator has builtin options
        const optionsType = tflite.BuiltinOptions[`${opName}Options`];
        if (!optionsType || op.builtinOptionsType() !== optionsType) {
            console.log(`  Attributes: No builtin options available`);
            return;
        }
        
        // Try to get the options class from the main tflite import
        const OptionsClass = tflite[optionsClassName];
        if (!OptionsClass) {
            console.log(`  Attributes: Options class ${optionsClassName} not found`);
            return;
        }
        
        const options = op.builtinOptions(new OptionsClass());
        if (!options) {
            console.log(`  Attributes: Failed to create options object`);
            return;
        }
        
        // Extract all available attributes dynamically
        const attributes = {};
        const prototype = Object.getPrototypeOf(options);
        const methodNames = Object.getOwnPropertyNames(prototype);
        
        for (const key of methodNames) {
            if (typeof options[key] === 'function' && key !== '__init' && key !== 'constructor') {
                try {
                    const value = options[key]();
                    attributes[key] = value;
                } catch (err) {
                    // Skip methods that throw errors (likely not getters)
                }
            }
        }
        
        if (Object.keys(attributes).length > 0) {
            console.log(`  Attributes:`);
            
            // Format specific attributes for better readability
            if (attributes.strideH !== undefined || attributes.strideW !== undefined) {
                const strideH = attributes.strideH || 1;
                const strideW = attributes.strideW || 1;
                console.log(`    Stride: (${strideH}, ${strideW})`);
            }
            
            if (attributes.dilationHFactor !== undefined || attributes.dilationWFactor !== undefined) {
                const dilationH = attributes.dilationHFactor || 1;
                const dilationW = attributes.dilationWFactor || 1;
                console.log(`    Dilation: (${dilationH}, ${dilationW})`);
            }
            
            if (attributes.filterHeight !== undefined || attributes.filterWidth !== undefined) {
                const filterH = attributes.filterHeight || 1;
                const filterW = attributes.filterWidth || 1;
                console.log(`    Filter: (${filterH}, ${filterW})`);
            }
            
            if (attributes.padding !== undefined) {
                const paddingName = tflite.Padding[attributes.padding] || `UNKNOWN(${attributes.padding})`;
                console.log(`    Padding: ${paddingName}`);
            }
            
            if (attributes.fusedActivationFunction !== undefined) {
                const activationName = tflite.ActivationFunctionType[attributes.fusedActivationFunction] || `UNKNOWN(${attributes.fusedActivationFunction})`;
                console.log(`    Activation: ${activationName}`);
            }
            
            // Show all raw attributes for completeness
            console.log(`    Raw attributes:`, attributes);
        } else {
            console.log(`  Attributes: No attributes extracted`);
        }
        
    } catch (error) {
        console.log(`  Attributes: Error extracting attributes - ${error.message}`);
    }
};

// Fallback function using flatbuffers (original implementation)
serial.Port.prototype.extractModelAttributesFlatbuffers = async function(modelBuffer) {
    console.log('=== Extracting Model Attributes using Flatbuffers ===');
    
    try {
        // Import the flatbuffers schema using the correct path
        const { Model } = await import('./dist/tflite.js');
        const tflite = await import('./dist/tflite.js');
        const flatbuffers = await import('./node_modules/flatbuffers/mjs/flatbuffers.js');
        
        // Verify the model buffer
        if (!modelBuffer || modelBuffer.length === 0) {
            console.error('Error: Invalid model buffer');
            return;
        }
        
        // Create ByteBuffer from model data (following parse-and-launch.js pattern)
        const bb = new flatbuffers.ByteBuffer(new Uint8Array(modelBuffer));
        
        // Get the model from flatbuffer
        const model = Model.getRootAsModel(bb);
        if (!model) {
            console.error('Error: Failed to get model from flatbuffer');
            return;
        }
        
        // Get subgraphs
        const subgraphsLength = model.subgraphsLength();
        if (subgraphsLength === 0) {
            console.error('Error: No subgraphs found in model');
            return;
        }
        
        // Process the main subgraph (usually index 0)
        const subgraph = model.subgraphs(0);
        if (!subgraph) {
            console.error('Error: Failed to get main subgraph');
            return;
        }
        
        // Get operators and tensors
        const operatorsLength = subgraph.operatorsLength();
        const tensorsLength = subgraph.tensorsLength();
        
        console.log('Model Analysis:');
        console.log(`- Number of operators: ${operatorsLength}`);
        console.log(`- Number of tensors: ${tensorsLength}`);
        
        // Extract operator information with comprehensive analysis (matching ns_tflite_analyze.py)
        console.log('\n=== Comprehensive Operator Analysis (ns_model.cc format) ===');
        
        // Arrays to store all the data (matching ns_model.cc format)
        const macEstimates = [];
        const macStrings = [];
        const outputShapes = [];
        const outputMagnitudes = [];
        const strideH = [];
        const strideW = [];
        const dilationH = [];
        const dilationW = [];
        const macFilterShapes = [];
        const readEstimates = [];
        const writeEstimates = [];
        const inputMagnitudes = [];
        
        // Helper function to get tensor shape as array
        function getTensorShapeArray(tensor) {
            if (!tensor || !tensor.shape) return [0, 0, 0, 0];
            const shape = [];
            for (let i = 0; i < tensor.shapeLength(); i++) {
                shape.push(tensor.shape(i));
            }
            // Pad to 4 dimensions if needed
            while (shape.length < 4) {
                shape.push(0);
            }
            return shape.slice(0, 4);
        }
        
        // Helper function to calculate tensor magnitude (product of all dimensions)
        function calculateTensorMagnitude(shape) {
            let magnitude = 1;
            for (let dim of shape) {
                magnitude *= dim;
            }
            return magnitude;
        }
        
        // Function to extract operator attributes for analysis (simplified version)
        async function extractOperatorAttributesForAnalysis(op, opName, tflite) {
            try {
                // Helper function to convert op name to PascalCase
                function toPascalCase(opName) {
                    return opName
                        .toLowerCase()
                        .split('_')
                        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                        .join('');
                }
                
                // Helper function to get options class name
                function getOptionsClassName(opName) {
                    // Special mapping for operator names to their correct options class names
                    const optionsClassMap = {
                        'CONV_2D': 'Conv2DOptions',
                        'DEPTHWISE_CONV_2D': 'DepthwiseConv2DOptions',
                        'FULLY_CONNECTED': 'FullyConnectedOptions',
                        'MAX_POOL_2D': 'Pool2DOptions',
                        'AVERAGE_POOL_2D': 'Pool2DOptions',
                        'ADD': 'AddOptions',
                        'MUL': 'MulOptions',
                        'PAD': 'PadOptions',
                        'RESHAPE': 'ReshapeOptions',
                        'TRANSPOSE': 'TransposeOptions',
                        'GATHER': 'GatherOptions',
                        'CONCATENATION': 'ConcatenationOptions',
                        'SOFTMAX': 'SoftmaxOptions',
                        'L2_NORMALIZATION': 'L2NormOptions',
                        'LOCAL_RESPONSE_NORMALIZATION': 'LocalResponseNormalizationOptions',
                        'RESIZE_BILINEAR': 'ResizeBilinearOptions',
                        'LSTM': 'LSTMOptions',
                        'RNN': 'RNNOptions',
                        'SVDF': 'SVDFOptions',
                        'CALL': 'CallOptions',
                        'EMBEDDING_LOOKUP_SPARSE': 'EmbeddingLookupSparseOptions',
                        'BATCH_TO_SPACE_ND': 'BatchToSpaceNDOptions',
                        'SPACE_TO_BATCH_ND': 'SpaceToBatchNDOptions',
                        'REDUCE_ANY': 'ReducerOptions',
                        'REDUCE_MAX': 'ReducerOptions',
                        'REDUCE_MIN': 'ReducerOptions',
                        'REDUCE_PROD': 'ReducerOptions',
                        'REDUCE_SUM': 'ReducerOptions',
                        'SKIP_GRAM': 'SkipGramOptions',
                        'SPACE_TO_DEPTH': 'SpaceToDepthOptions'
                    };
                    
                    return optionsClassMap[opName] || `${toPascalCase(opName)}Options`;
                }
                
                const optionsClassName = getOptionsClassName(opName);
                
                // Check if this operator has builtin options
                // Map operator names to the correct BuiltinOptions enum values
                const optionsTypeMap = {
                    'CONV_2D': tflite.BuiltinOptions.Conv2DOptions,
                    'DEPTHWISE_CONV_2D': tflite.BuiltinOptions.DepthwiseConv2DOptions,
                    'FULLY_CONNECTED': tflite.BuiltinOptions.FullyConnectedOptions,
                    'MAX_POOL_2D': tflite.BuiltinOptions.Pool2DOptions,
                    'AVERAGE_POOL_2D': tflite.BuiltinOptions.Pool2DOptions,
                    'ADD': tflite.BuiltinOptions.AddOptions,
                    'MUL': tflite.BuiltinOptions.MulOptions,
                    'PAD': tflite.BuiltinOptions.PadOptions,
                    'RESHAPE': tflite.BuiltinOptions.ReshapeOptions,
                    'TRANSPOSE': tflite.BuiltinOptions.TransposeOptions,
                    'GATHER': tflite.BuiltinOptions.GatherOptions,
                    'CONCATENATION': tflite.BuiltinOptions.ConcatenationOptions,
                    'SOFTMAX': tflite.BuiltinOptions.SoftmaxOptions,
                    'L2_NORMALIZATION': tflite.BuiltinOptions.L2NormOptions,
                    'LOCAL_RESPONSE_NORMALIZATION': tflite.BuiltinOptions.LocalResponseNormalizationOptions,
                    'RESIZE_BILINEAR': tflite.BuiltinOptions.ResizeBilinearOptions,
                    'LSTM': tflite.BuiltinOptions.LSTMOptions,
                    'RNN': tflite.BuiltinOptions.RNNOptions,
                    'SVDF': tflite.BuiltinOptions.SVDFOptions,
                    'CALL': tflite.BuiltinOptions.CallOptions,
                    'EMBEDDING_LOOKUP_SPARSE': tflite.BuiltinOptions.EmbeddingLookupSparseOptions,
                    'BATCH_TO_SPACE_ND': tflite.BuiltinOptions.BatchToSpaceNDOptions,
                    'SPACE_TO_BATCH_ND': tflite.BuiltinOptions.SpaceToBatchNDOptions,
                    'REDUCE_ANY': tflite.BuiltinOptions.ReducerOptions,
                    'REDUCE_MAX': tflite.BuiltinOptions.ReducerOptions,
                    'REDUCE_MIN': tflite.BuiltinOptions.ReducerOptions,
                    'REDUCE_PROD': tflite.BuiltinOptions.ReducerOptions,
                    'REDUCE_SUM': tflite.BuiltinOptions.ReducerOptions,
                    'SKIP_GRAM': tflite.BuiltinOptions.SkipGramOptions,
                    'SPACE_TO_DEPTH': tflite.BuiltinOptions.SpaceToDepthOptions
                };
                
                const optionsType = optionsTypeMap[opName];
                
                if (!optionsType || op.builtinOptionsType() !== optionsType) {
                    // No builtin options for this operator, return defaults
                    return { strideH: 0, strideW: 0, dilationHFactor: 0, dilationWFactor: 0 };
                }
                
                // Try to get the options class from the main tflite import
                const OptionsClass = tflite[optionsClassName];
                
                if (!OptionsClass) {
                    // Options class not found, return defaults
                    return { strideH: 0, strideW: 0, dilationHFactor: 0, dilationWFactor: 0 };
                }
                
                const options = op.builtinOptions(new OptionsClass());
                
                if (!options) {
                    // Failed to create options object, return defaults
                    return { strideH: 0, strideW: 0, dilationHFactor: 0, dilationWFactor: 0 };
                }
                
                // Extract all available attributes and default to 0 for missing ones
                const attributes = {
                    strideH: 0,
                    strideW: 0,
                    dilationHFactor: 0,
                    dilationWFactor: 0
                };
                
                const prototype = Object.getPrototypeOf(options);
                const methodNames = Object.getOwnPropertyNames(prototype);
                
                for (const key of methodNames) {
                    if (typeof options[key] === 'function' && key !== '__init' && key !== 'constructor') {
                        try {
                            const value = options[key]();
                            attributes[key] = value;
                        } catch (err) {
                            // Skip methods that throw errors
                        }
                    }
                }
                
                return attributes;
                
            } catch (error) {
                // Any error, return defaults
                return { strideH: 0, strideW: 0, dilationHFactor: 0, dilationWFactor: 0 };
            }
        }
        
        for (let i = 0; i < operatorsLength; i++) {
            const op = subgraph.operators(i);
            if (!op) continue;
            
            // Get operator code
            const opCodeIndex = op.opcodeIndex();
            const opCode = model.operatorCodes(opCodeIndex);
            
            let opName = 'Unknown';
            if (opCode) {
                const builtinCode = opCode.builtinCode();
                if (builtinCode !== tflite.BuiltinOperator.CUSTOM) {
                    opName = tflite.BuiltinOperator[builtinCode];
                } else if (opCode.customCode()) {
                    opName = opCode.customCode();
                }
            }
            
            console.log(`\nOperator ${i}: ${opName}`);
            
            // Get input and output tensors
            const inputIndices = op.inputsArray().filter(idx => idx !== -1);
            const outputIndices = op.outputsArray().filter(idx => idx !== -1);
            
            // Get tensor shapes
            let inputs = { shape: [0, 0, 0, 0] };
            let outputs = { shape: [0, 0, 0, 0] };
            let filter = { shape: [0, 0, 0, 0] };
            
            if (inputIndices.length > 0) {
                const inputTensor = subgraph.tensors(inputIndices[0]);
                if (inputTensor) {
                    inputs.shape = getTensorShapeArray(inputTensor);
                    console.log(`  Input shape: [${inputs.shape.join(', ')}]`);
                }
            }
            
            if (outputIndices.length > 0) {
                const outputTensor = subgraph.tensors(outputIndices[0]);
                if (outputTensor) {
                    outputs.shape = getTensorShapeArray(outputTensor);
                    console.log(`  Output shape: [${outputs.shape.join(', ')}]`);
                }
            }
            
            // Get filter tensor for convolution operations
            if (inputIndices.length > 1) {
                const filterTensor = subgraph.tensors(inputIndices[1]);
                if (filterTensor) {
                    filter.shape = getTensorShapeArray(filterTensor);
                    console.log(`  Filter shape: [${filter.shape.join(', ')}]`);
                }
            }
            
            // Extract operator attributes
            const attributes = await extractOperatorAttributesForAnalysis(op, opName, tflite);
            console.log(`  Attributes: strideH=${attributes.strideH || 0}, strideW=${attributes.strideW || 0}, dilationH=${attributes.dilationHFactor || 0}, dilationW=${attributes.dilationWFactor || 0}`);
            if (opName === 'MAX_POOL_2D' || opName === 'AVERAGE_POOL_2D') {
                console.log(`  Pooling specific: filterWidth=${attributes.filterWidth || 0}, filterHeight=${attributes.filterHeight || 0}, padding=${attributes.padding || 0}`);
            }
            
            // Calculate MACs and other metrics based on operator type
            let macs = 0;
            let macString = "0";
            let memoryReads = 0;
            let memoryWrites = 0;
            
            if (opName === "CONV_2D") {
                // CONV_2D: filter_width * filter_height * output_width * output_height * input_channels * output_channels
                macs = filter.shape[1] * filter.shape[2] * outputs.shape[1] * outputs.shape[2] * filter.shape[0] * inputs.shape[3];
                macString = `${filter.shape[1]}*${filter.shape[2]}*${outputs.shape[1]}*${outputs.shape[2]}*${filter.shape[0]}*${inputs.shape[3]}`;
                
                // Memory reads: filter_width * filter_height * input_channels * output_width * output_height
                memoryReads = filter.shape[1] * filter.shape[2] * inputs.shape[3] * outputs.shape[1] * outputs.shape[2];
                
                // Memory writes: output_width * output_height * output_channels
                memoryWrites = outputs.shape[1] * outputs.shape[2] * outputs.shape[3];
                
            } else if (opName === "DEPTHWISE_CONV_2D") {
                // DEPTHWISE_CONV_2D: filter_width * filter_height * output_width * output_height * channels
                macs = filter.shape[1] * filter.shape[2] * outputs.shape[1] * outputs.shape[2] * filter.shape[3];
                macString = `${filter.shape[1]}*${filter.shape[2]}*${outputs.shape[1]}*${outputs.shape[2]}*${filter.shape[3]}`;
                
                // Memory reads: filter_width * filter_height * input_channels * output_width * output_height
                memoryReads = filter.shape[1] * filter.shape[2] * inputs.shape[3] * outputs.shape[1] * outputs.shape[2];
                
                // Memory writes: output_width * output_height * output_channels
                memoryWrites = outputs.shape[1] * outputs.shape[2] * outputs.shape[3];
                
            } else if (opName === "FULLY_CONNECTED") {
                // FULLY_CONNECTED: accum_depth * output_depth * batch_size
                macs = filter.shape[filter.shape.length - 1] * outputs.shape[0] * outputs.shape[1];
                macString = `${filter.shape[filter.shape.length - 1]}*${outputs.shape[0]}*${outputs.shape[1]}`;
                
                // Memory reads: accum_depth * output_depth * batch_size
                memoryReads = filter.shape[filter.shape.length - 1] * outputs.shape[0] * outputs.shape[1];
                
                // Memory writes: batch_size * output_depth
                memoryWrites = outputs.shape[0] * outputs.shape[1];
                
            } else {
                // Other operations: no MACs
                macs = 0;
                macString = "0";
                
                // Memory reads/writes based on tensor magnitudes
                memoryReads = calculateTensorMagnitude(inputs.shape);
                memoryWrites = calculateTensorMagnitude(outputs.shape);
            }
            
            // Calculate tensor magnitudes
            const inputMagnitude = calculateTensorMagnitude(inputs.shape);
            const outputMagnitude = calculateTensorMagnitude(outputs.shape);
            
            // Store all the data
            macEstimates.push(macs);
            macStrings.push(macString);
            outputShapes.push(outputs.shape.join('*'));
            outputMagnitudes.push(outputMagnitude);
            strideH.push(attributes.strideH || 0);
            strideW.push(attributes.strideW || 0);
            dilationH.push(attributes.dilationHFactor || 0);
            dilationW.push(attributes.dilationWFactor || 0);
            macFilterShapes.push(filter.shape.join('*'));
            readEstimates.push(memoryReads);
            writeEstimates.push(memoryWrites);
            inputMagnitudes.push(inputMagnitude);
            
            // Log the analysis for this operator
            console.log(`  MACs: ${macs} (${macString})`);
            console.log(`  Output Shape: ${outputs.shape.join('*')}`);
            console.log(`  Filter Shape: ${filter.shape.join('*')}`);
            console.log(`  Stride: (${attributes.strideH || 0}, ${attributes.strideW || 0})`);
            console.log(`  Dilation: (${attributes.dilationHFactor || 0}, ${attributes.dilationWFactor || 0})`);
            console.log(`  Memory Reads: ${memoryReads}, Writes: ${memoryWrites}`);
        }
        
        // Generate the ns_model.cc format output
        console.log('\n=== ns_model.cc Format Output ===');
        console.log(`uint32_t model_mac_estimates[${macEstimates.length}] = {${macEstimates.join(', ')}};`);
        console.log(`const char* model_mac_strings[] = {"${macStrings.join('", "')}";`);
        console.log(`const char* model_output_shapes[] = {"${outputShapes.join('", "')}";`);
        console.log(`const uint32_t model_output_magnitudes[] = {${outputMagnitudes.join(', ')};`);
        console.log(`const uint32_t model_stride_h[] = {${strideH.join(', ')};`);
        console.log(`const uint32_t model_stride_w[] = {${strideW.join(', ')};`);
        console.log(`const uint32_t model_dilation_h[] = {${dilationH.join(', ')};`);
        console.log(`const uint32_t model_dilation_w[] = {${dilationW.join(', ')};`);
        console.log(`const char* model_mac_filter_shapes[] = {"${macFilterShapes.join('", "')}";`);
        console.log(`const uint32_t model_read_estimate[] = {${readEstimates.join(', ')};`);
        console.log(`const uint32_t model_write_estimate[] = {${writeEstimates.join(', ')};`);
        console.log(`const uint32_t model_input_magnitudes[] = {${inputMagnitudes.join(', ')};`);
             
        console.log('');
        
        // // Extract tensor information
        // console.log('\n=== Tensor Details ===');
        // for (let i = 0; i < tensorsLength; i++) {
        //     const tensor = subgraph.tensors(i);
        //     if (!tensor) continue;
            
        //     console.log(`Tensor ${i}:`);
            
        //     // Name
        //     if (tensor.name()) {
        //         console.log(`  Name: ${tensor.name()}`);
        //     }
            
        //     // Type
        //     console.log(`  Type: ${getTensorTypeName(tensor)}`);
            
        //     // Shape
        //     console.log(`  Shape: ${getTensorShape(tensor)}`);
            
        //     // Quantization
        //     const quantization = tensor.quantization();
        //     if (quantization) {
        //         const scaleLength = quantization.scaleLength();
        //         const zeroPointLength = quantization.zeroPointLength();
                
        //         if (scaleLength > 0) {
        //             console.log(`  Scale: ${quantization.scale(0)}`);
        //         }
        //         if (zeroPointLength > 0) {
        //             console.log(`  Zero Point: ${quantization.zeroPoint(0)}`);
        //         }
        //     }
            
        //     console.log('');
        // }
        
        console.log('=== Model Attributes Extraction Complete ===');
        
    } catch (error) {
        console.error('Error extracting model attributes with flatbuffers:', error);
    }
};

// Enhanced function to extract detailed operator attributes using dynamic Flatbuffers access
serial.Port.prototype.extractDetailedOperatorAttributes = async function(modelBuffer) {
    console.log('=== Extracting Detailed Operator Attributes ===');
    console.log('Function called with modelBuffer length:', modelBuffer ? modelBuffer.length : 'null');
    
    try {
        // Import the flatbuffers schema
        const { Model } = await import('./dist/tflite.js');
        const tflite = await import('./dist/tflite.js');
        const flatbuffers = await import('./node_modules/flatbuffers/mjs/flatbuffers.js');
        
        // Helper function to convert op name to PascalCase
        function toPascalCase(opName) {
            return opName
                .toLowerCase()
                .split('_')
                .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                .join('');
        }
        
        // Helper function to get options class name
        function getOptionsClassName(opName) {
            return `${toPascalCase(opName)}Options`;
        }
        
        // Dynamic function to extract operator attributes
        async function extractOpAttributes(op, opName, tflite) {
            const optionsClassName = getOptionsClassName(opName); // e.g., Conv2DOptions
            
            console.log(`  Debug: optionsClassName = ${optionsClassName}`);
            
            // Check if this operator has builtin options
            const optionsType = tflite.BuiltinOptions[`${opName}Options`];
            console.log(`  Debug: optionsType = ${optionsType}, op.builtinOptionsType() = ${op.builtinOptionsType()}`);
            
            if (!optionsType || op.builtinOptionsType() !== optionsType) {
                console.log(`  Debug: No matching options type for ${opName}`);
                return null;
            }
            
            try {
                // Try to get the options class from the main tflite import
                const OptionsClass = tflite[optionsClassName];
                console.log(`  Debug: OptionsClass found = ${OptionsClass ? 'Yes' : 'No'}`);
                
                if (!OptionsClass) {
                    console.warn(`Options class ${optionsClassName} not found in tflite import`);
                    console.log(`  Debug: Available tflite keys:`, Object.keys(tflite).filter(k => k.includes('Options')));
                    return null;
                }
                
                const options = op.builtinOptions(new OptionsClass());
                console.log(`  Debug: options object created = ${options ? 'Yes' : 'No'}`);
                
                if (!options) {
                    return null;
                }
                
                // Extract all available attributes dynamically
                const out = {};
                const prototype = Object.getPrototypeOf(options);
                const methodNames = Object.getOwnPropertyNames(prototype);
                console.log(`  Debug: Available methods:`, methodNames);
                
                for (const key of methodNames) {
                    if (typeof options[key] === 'function' && key !== '__init' && key !== 'constructor') {
                        try {
                            const value = options[key]();
                            out[key] = value;
                            console.log(`  Debug: Extracted ${key} = ${value}`);
                        } catch (err) {
                            console.log(`  Debug: Failed to extract ${key}: ${err.message}`);
                        }
                    }
                }
                
                console.log(`  Debug: Final extracted attributes:`, out);
                return out;
            } catch (err) {
                console.warn(`Could not load or parse options for ${opName}:`, err);
                return null;
            }
        }
        
        // Create ByteBuffer from model data
        const bb = new flatbuffers.ByteBuffer(new Uint8Array(modelBuffer));
        const model = Model.getRootAsModel(bb);
        
        if (!model || !model.subgraphsLength()) {
            console.error('No subgraphs found in model');
            return;
        }
        
        const subgraph = model.subgraphs(0);
        const operatorsLength = subgraph.operatorsLength();
        
        console.log(`\nAnalyzing ${operatorsLength} operators for detailed attributes...`);
        console.log('Debug: Available tflite exports:', Object.keys(tflite).filter(k => k.includes('Options')));
        console.log('Debug: BuiltinOptions enum:', tflite.BuiltinOptions);
        
        for (let i = 0; i < operatorsLength; i++) {
            const op = subgraph.operators(i);
            if (!op) continue;
            
            const opCodeIndex = op.opcodeIndex();
            const opCode = model.operatorCodes(opCodeIndex);
            const builtinCode = opCode.builtinCode();
            const opName = tflite.BuiltinOperator[builtinCode] || 'UNKNOWN';
            
            console.log(`\nOperator ${i}: ${opName}`);
            
            // Extract attributes dynamically
            const options = await extractOpAttributes(op, opName, tflite);
            
            if (options) {
                console.log(`  ${opName} #${i} options:`, options);
                
                // Format specific attributes for better readability
                if (options.strideH !== undefined || options.strideW !== undefined) {
                    const strideH = options.strideH || 1;
                    const strideW = options.strideW || 1;
                    console.log(`    Stride: (${strideH}, ${strideW})`);
                }
                
                if (options.dilationHFactor !== undefined || options.dilationWFactor !== undefined) {
                    const dilationH = options.dilationHFactor || 1;
                    const dilationW = options.dilationWFactor || 1;
                    console.log(`    Dilation: (${dilationH}, ${dilationW})`);
                }
                
                if (options.filterHeight !== undefined || options.filterWidth !== undefined) {
                    const filterH = options.filterHeight || 1;
                    const filterW = options.filterWidth || 1;
                    console.log(`    Filter: (${filterH}, ${filterW})`);
                }
                
                if (options.padding !== undefined) {
                    const paddingName = tflite.Padding[options.padding] || `UNKNOWN(${options.padding})`;
                    console.log(`    Padding: ${paddingName}`);
                }
                
                if (options.fusedActivationFunction !== undefined) {
                    const activationName = tflite.ActivationFunctionType[options.fusedActivationFunction] || `UNKNOWN(${options.fusedActivationFunction})`;
                    console.log(`    Activation: ${activationName}`);
                }
            } else {
                console.log(`  ${opName} #${i}: No options available`);
            }
        }
        
        console.log('\n=== Detailed Operator Attributes Extraction Complete ===');
        
    } catch (error) {
        console.error('Error extracting detailed operator attributes:', error);
    }
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
    
    // Extract and log model attributes, then send derived arrays to EVB
    try {
        const fileBuf = new Uint8Array(await file.arrayBuffer());
        await this.extractModelAttributes(fileBuf);
        
        // Extract derived values and send to EVB
        console.log('Extracting derived values to send to EVB...');
        const derivedValues = await this.extractDerivedValuesForEVB(fileBuf);
        if (derivedValues) {
            console.log('Sending derived arrays to EVB...');
            await this.sendDerivedArrays(derivedValues);
            console.log('Derived arrays sent successfully');
        }
    } catch (error) {
        console.error('Failed to extract model attributes or send derived arrays:', error);
    }
    
    if (onComplete) onComplete();
};

// Extract derived values from TFLite model for sending to EVB
serial.Port.prototype.extractDerivedValuesForEVB = async function(modelBuffer) {
    try {
        console.log('Extracting derived values by reusing existing analysis function...');
        
        // Import the flatbuffers schema using the same approach as extractModelAttributesFlatbuffers
        const { Model } = await import('./dist/tflite.js');
        const tflite = await import('./dist/tflite.js');
        const flatbuffers = await import('./node_modules/flatbuffers/mjs/flatbuffers.js');
        
        // Create ByteBuffer from model data
        const bb = new flatbuffers.ByteBuffer(new Uint8Array(modelBuffer));
        
        // Get the model from flatbuffer
        const model = Model.getRootAsModel(bb);
        if (!model) {
            console.error('Error: Failed to get model from flatbuffer');
            return null;
        }
        
        // Get subgraphs
        const subgraphsLength = model.subgraphsLength();
        if (subgraphsLength === 0) {
            console.error('Error: No subgraphs found in model');
            return null;
        }
        
        // Process the main subgraph (usually index 0)
        const subgraph = model.subgraphs(0);
        if (!subgraph) {
            console.error('Error: Failed to get main subgraph');
            return null;
        }
        
        const operatorsLength = subgraph.operatorsLength();
        console.log(`Model has ${operatorsLength} operators`);
        
        // Arrays to store derived values (reusing the same structure as extractModelAttributesFlatbuffers)
        const macEstimates = [];
        const strideH = [];
        const strideW = [];
        const dilationH = [];
        const dilationW = [];
        const outputMagnitudes = [];
        const readEstimates = [];
        const writeEstimates = [];
        const inputMagnitudes = [];
        
        // Arrays to store string representations for TFLM profiling
        const macStrings = [];
        const outputShapes = [];
        const filterShapes = [];
        
        // Helper function to get tensor shape as array (reused from extractModelAttributesFlatbuffers)
        function getTensorShapeArray(tensor) {
            if (!tensor || !tensor.shape) return [0, 0, 0, 0];
            const shape = [];
            for (let i = 0; i < tensor.shapeLength(); i++) {
                shape.push(tensor.shape(i));
            }
            // Pad to 4 dimensions if needed
            while (shape.length < 4) {
                shape.push(0);
            }
            return shape.slice(0, 4);
        }
        
        // Helper function to calculate tensor magnitude (reused from extractModelAttributesFlatbuffers)
        function calculateTensorMagnitude(shape) {
            let magnitude = 1;
            for (let dim of shape) {
                magnitude *= dim;
            }
            return magnitude;
        }
        
        // Reuse the existing extractOperatorAttributesForAnalysis function
        async function extractOperatorAttributesForAnalysis(op, opName, tflite) {
            try {
                // Helper function to convert op name to PascalCase
                function toPascalCase(opName) {
                    return opName
                        .toLowerCase()
                        .split('_')
                        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
                        .join('');
                }
                
                // Helper function to get options class name
                function getOptionsClassName(opName) {
                    const optionsClassMap = {
                        'CONV_2D': 'Conv2DOptions',
                        'DEPTHWISE_CONV_2D': 'DepthwiseConv2DOptions',
                        'FULLY_CONNECTED': 'FullyConnectedOptions',
                        'MAX_POOL_2D': 'Pool2DOptions',
                        'AVERAGE_POOL_2D': 'Pool2DOptions',
                        'ADD': 'AddOptions',
                        'MUL': 'MulOptions',
                        'PAD': 'PadOptions',
                        'RESHAPE': 'ReshapeOptions',
                        'TRANSPOSE': 'TransposeOptions',
                        'GATHER': 'GatherOptions',
                        'CONCATENATION': 'ConcatenationOptions',
                        'SOFTMAX': 'SoftmaxOptions',
                        'L2_NORMALIZATION': 'L2NormOptions',
                        'LOCAL_RESPONSE_NORMALIZATION': 'LocalResponseNormalizationOptions',
                        'RESIZE_BILINEAR': 'ResizeBilinearOptions',
                        'LSTM': 'LSTMOptions',
                        'RNN': 'RNNOptions',
                        'SVDF': 'SVDFOptions',
                        'CALL': 'CallOptions',
                        'EMBEDDING_LOOKUP_SPARSE': 'EmbeddingLookupSparseOptions',
                        'BATCH_TO_SPACE_ND': 'BatchToSpaceNDOptions',
                        'SPACE_TO_BATCH_ND': 'SpaceToBatchNDOptions',
                        'REDUCE_ANY': 'ReducerOptions',
                        'REDUCE_MAX': 'ReducerOptions',
                        'REDUCE_MIN': 'ReducerOptions',
                        'REDUCE_PROD': 'ReducerOptions',
                        'REDUCE_SUM': 'ReducerOptions',
                        'SKIP_GRAM': 'SkipGramOptions',
                        'SPACE_TO_DEPTH': 'SpaceToDepthOptions'
                    };
                    
                    return optionsClassMap[opName] || `${toPascalCase(opName)}Options`;
                }
                
                const optionsClassName = getOptionsClassName(opName);
                
                // Map operator names to the correct BuiltinOptions enum values
                const optionsTypeMap = {
                    'CONV_2D': tflite.BuiltinOptions.Conv2DOptions,
                    'DEPTHWISE_CONV_2D': tflite.BuiltinOptions.DepthwiseConv2DOptions,
                    'FULLY_CONNECTED': tflite.BuiltinOptions.FullyConnectedOptions,
                    'MAX_POOL_2D': tflite.BuiltinOptions.Pool2DOptions,
                    'AVERAGE_POOL_2D': tflite.BuiltinOptions.Pool2DOptions,
                    'ADD': tflite.BuiltinOptions.AddOptions,
                    'MUL': tflite.BuiltinOptions.MulOptions,
                    'PAD': tflite.BuiltinOptions.PadOptions,
                    'RESHAPE': tflite.BuiltinOptions.ReshapeOptions,
                    'TRANSPOSE': tflite.BuiltinOptions.TransposeOptions,
                    'GATHER': tflite.BuiltinOptions.GatherOptions,
                    'CONCATENATION': tflite.BuiltinOptions.ConcatenationOptions,
                    'SOFTMAX': tflite.BuiltinOptions.SoftmaxOptions,
                    'L2_NORMALIZATION': tflite.BuiltinOptions.L2NormOptions,
                    'LOCAL_RESPONSE_NORMALIZATION': tflite.BuiltinOptions.LocalResponseNormalizationOptions,
                    'RESIZE_BILINEAR': tflite.BuiltinOptions.ResizeBilinearOptions,
                    'LSTM': tflite.BuiltinOptions.LSTMOptions,
                    'RNN': tflite.BuiltinOptions.RNNOptions,
                    'SVDF': tflite.BuiltinOptions.SVDFOptions,
                    'CALL': tflite.BuiltinOptions.CallOptions,
                    'EMBEDDING_LOOKUP_SPARSE': tflite.BuiltinOptions.EmbeddingLookupSparseOptions,
                    'BATCH_TO_SPACE_ND': tflite.BuiltinOptions.BatchToSpaceNDOptions,
                    'SPACE_TO_BATCH_ND': tflite.BuiltinOptions.SpaceToBatchNDOptions,
                    'REDUCE_ANY': tflite.BuiltinOptions.ReducerOptions,
                    'REDUCE_MAX': tflite.BuiltinOptions.ReducerOptions,
                    'REDUCE_MIN': tflite.BuiltinOptions.ReducerOptions,
                    'REDUCE_PROD': tflite.BuiltinOptions.ReducerOptions,
                    'REDUCE_SUM': tflite.BuiltinOptions.ReducerOptions,
                    'SKIP_GRAM': tflite.BuiltinOptions.SkipGramOptions,
                    'SPACE_TO_DEPTH': tflite.BuiltinOptions.SpaceToDepthOptions
                };
                
                const optionsType = optionsTypeMap[opName];
                
                if (!optionsType || op.builtinOptionsType() !== optionsType) {
                    return { strideH: 0, strideW: 0, dilationHFactor: 0, dilationWFactor: 0 };
                }
                
                const OptionsClass = tflite[optionsClassName];
                
                if (!OptionsClass) {
                    return { strideH: 0, strideW: 0, dilationHFactor: 0, dilationWFactor: 0 };
                }
                
                const options = op.builtinOptions(new OptionsClass());
                
                if (!options) {
                    return { strideH: 0, strideW: 0, dilationHFactor: 0, dilationWFactor: 0 };
                }
                
                const attributes = {
                    strideH: 0,
                    strideW: 0,
                    dilationHFactor: 0,
                    dilationWFactor: 0
                };
                
                const prototype = Object.getPrototypeOf(options);
                const methodNames = Object.getOwnPropertyNames(prototype);
                
                for (const key of methodNames) {
                    if (typeof options[key] === 'function' && key !== '__init' && key !== 'constructor') {
                        try {
                            const value = options[key]();
                            attributes[key] = value;
                        } catch (err) {
                            // Skip methods that throw errors
                        }
                    }
                }
                
                return attributes;
                
            } catch (error) {
                return { strideH: 0, strideW: 0, dilationHFactor: 0, dilationWFactor: 0 };
            }
        }
        
        // Process each operator using the same logic as extractModelAttributesFlatbuffers
        for (let i = 0; i < operatorsLength; i++) {
            const op = subgraph.operators(i);
            if (!op) continue;
            
            // Get operator code
            const opCodeIndex = op.opcodeIndex();
            const opCode = model.operatorCodes(opCodeIndex);
            
            let opName = 'Unknown';
            if (opCode) {
                const builtinCode = opCode.builtinCode();
                if (builtinCode !== tflite.BuiltinOperator.CUSTOM) {
                    opName = tflite.BuiltinOperator[builtinCode];
                } else if (opCode.customCode()) {
                    opName = opCode.customCode();
                }
            }
            
            // Get input and output tensors
            const inputIndices = op.inputsArray().filter(idx => idx !== -1);
            const outputIndices = op.outputsArray().filter(idx => idx !== -1);
            
            // Get tensor shapes
            let inputs = { shape: [0, 0, 0, 0] };
            let outputs = { shape: [0, 0, 0, 0] };
            let filter = { shape: [0, 0, 0, 0] };
            
            if (inputIndices.length > 0) {
                const inputTensor = subgraph.tensors(inputIndices[0]);
                if (inputTensor) {
                    inputs.shape = getTensorShapeArray(inputTensor);
                }
            }
            
            if (outputIndices.length > 0) {
                const outputTensor = subgraph.tensors(outputIndices[0]);
                if (outputTensor) {
                    outputs.shape = getTensorShapeArray(outputTensor);
                }
            }
            
            // Get filter tensor for convolution operations
            if (inputIndices.length > 1) {
                const filterTensor = subgraph.tensors(inputIndices[1]);
                if (filterTensor) {
                    filter.shape = getTensorShapeArray(filterTensor);
                }
            }
            
            // Extract operator attributes
            const attributes = await extractOperatorAttributesForAnalysis(op, opName, tflite);
            
            // Calculate MACs and other metrics based on operator type (same logic as extractModelAttributesFlatbuffers)
            let macs = 0;
            let memoryReads = 0;
            let memoryWrites = 0;
            
            if (opName === "CONV_2D") {
                macs = filter.shape[1] * filter.shape[2] * outputs.shape[1] * outputs.shape[2] * filter.shape[0] * inputs.shape[3];
                memoryReads = filter.shape[1] * filter.shape[2] * inputs.shape[3] * outputs.shape[1] * outputs.shape[2];
                memoryWrites = outputs.shape[1] * outputs.shape[2] * outputs.shape[3];
                
            } else if (opName === "DEPTHWISE_CONV_2D") {
                macs = filter.shape[1] * filter.shape[2] * outputs.shape[1] * outputs.shape[2] * filter.shape[3];
                memoryReads = filter.shape[1] * filter.shape[2] * inputs.shape[3] * outputs.shape[1] * outputs.shape[2];
                memoryWrites = outputs.shape[1] * outputs.shape[2] * outputs.shape[3];
                
            } else if (opName === "FULLY_CONNECTED") {
                macs = filter.shape[filter.shape.length - 1] * outputs.shape[0] * outputs.shape[1];
                memoryReads = filter.shape[filter.shape.length - 1] * outputs.shape[0] * outputs.shape[1];
                memoryWrites = outputs.shape[0] * outputs.shape[1];
                
            } else {
                macs = 0;
                memoryReads = calculateTensorMagnitude(inputs.shape);
                memoryWrites = calculateTensorMagnitude(outputs.shape);
            }
            
            // Calculate tensor magnitudes
            const inputMagnitude = calculateTensorMagnitude(inputs.shape);
            const outputMagnitude = calculateTensorMagnitude(outputs.shape);
            
                    // Store all the data
        macEstimates.push(macs);
        strideH.push(attributes.strideH || 0);
        strideW.push(attributes.strideW || 0);
        dilationH.push(attributes.dilationHFactor || 0);
        dilationW.push(attributes.dilationWFactor || 0);
        outputMagnitudes.push(outputMagnitude);
        readEstimates.push(memoryReads);
        writeEstimates.push(memoryWrites);
        inputMagnitudes.push(inputMagnitude);
        
        // Generate string representations for TFLM profiling
        let macString = "0";
        let outputShapeString = "0*0*0*0";
        let filterShapeString = "0*0*0*0";
        
        if (opName === "CONV_2D") {
            macString = `${filter.shape[1]}*${filter.shape[2]}*${outputs.shape[1]}*${outputs.shape[2]}*${filter.shape[0]}*${inputs.shape[3]}`;
            outputShapeString = `${outputs.shape[0]}*${outputs.shape[1]}*${outputs.shape[2]}*${outputs.shape[3]}`;
            filterShapeString = `${filter.shape[0]}*${filter.shape[1]}*${filter.shape[2]}*${filter.shape[3]}`;
        } else if (opName === "DEPTHWISE_CONV_2D") {
            macString = `${filter.shape[1]}*${filter.shape[2]}*${outputs.shape[1]}*${outputs.shape[2]}*${filter.shape[3]}`;
            outputShapeString = `${outputs.shape[0]}*${outputs.shape[1]}*${outputs.shape[2]}*${outputs.shape[3]}`;
            filterShapeString = `${filter.shape[0]}*${filter.shape[1]}*${filter.shape[2]}*${filter.shape[3]}`;
        } else if (opName === "FULLY_CONNECTED") {
            macString = `${filter.shape[filter.shape.length - 1]}*${outputs.shape[0]}*${outputs.shape[1]}`;
            outputShapeString = `${outputs.shape[0]}*${outputs.shape[1]}`;
            filterShapeString = `${filter.shape[0]}*${filter.shape[1]}`;
        } else {
            outputShapeString = `${outputs.shape[0]}*${outputs.shape[1]}*${outputs.shape[2]}*${outputs.shape[3]}`;
        }
        
        macStrings.push(macString);
        outputShapes.push(outputShapeString);
        filterShapes.push(filterShapeString);
        }
        
        console.log(`Extracted derived values for ${macEstimates.length} operators`);
        console.log('MAC estimates:', macEstimates);
        console.log('Stride H:', strideH);
        
        return {
            macEstimates,
            strideH,
            strideW,
            dilationH,
            dilationW,
            outputMagnitudes,
            readEstimates,
            writeEstimates,
            inputMagnitudes,
            macStrings,
            outputShapes,
            filterShapes
        };
        
    } catch (error) {
        console.error('Error extracting derived values for EVB:', error);
        return null;
    }
};

// Send derived arrays to EVB in chunks (similar to model upload)
serial.Port.prototype.sendDerivedArrays = async function(derivedValues) {
    console.log('Sending derived arrays to EVB...');
    const DERIVED_ARRAYS_CMD = 0x06; // New command type
    const { 
        macEstimates, 
        strideH, 
        strideW, 
        dilationH, 
        dilationW, 
        outputMagnitudes, 
        readEstimates, 
        writeEstimates, 
        inputMagnitudes,
        macStrings,
        outputShapes,
        filterShapes
    } = derivedValues;
    const numOperators = macEstimates.length;
    
    // Use the same chunking approach as model upload
    const CHUNK_SIZE = 480; // Same as model upload chunk size
    const METADATA_SIZE = 8; // total_ops (4) + chunk_ops (4)
    const OPERATOR_DATA_SIZE = 36; // 9 values * 4 bytes each: mac, strideH, strideW, dilationH, dilationW, outputMag, readEst, writeEst, inputMag
    const MAX_OPERATORS_PER_CHUNK = Math.floor((CHUNK_SIZE - METADATA_SIZE) / OPERATOR_DATA_SIZE);
    
    console.log(`Chunking: CHUNK_SIZE=${CHUNK_SIZE}, METADATA_SIZE=${METADATA_SIZE}, OPERATOR_DATA_SIZE=${OPERATOR_DATA_SIZE}, MAX_OPERATORS_PER_CHUNK=${MAX_OPERATORS_PER_CHUNK}`);
    
    const totalChunks = Math.ceil(numOperators / MAX_OPERATORS_PER_CHUNK);
    
    console.log(`Sending derived arrays: ${numOperators} operators in ${totalChunks} chunks (max ${MAX_OPERATORS_PER_CHUNK} operators per chunk)`);
    
    for (let chunkId = 0; chunkId < totalChunks; chunkId++) {
        const startIdx = chunkId * MAX_OPERATORS_PER_CHUNK;
        const endIdx = Math.min(startIdx + MAX_OPERATORS_PER_CHUNK, numOperators);
        const operatorsInChunk = endIdx - startIdx;
        
        // Create payload for this chunk: chunk metadata + operator data
        const payloadSize = METADATA_SIZE + operatorsInChunk * OPERATOR_DATA_SIZE;
        const payload = new ArrayBuffer(payloadSize);
        const view = new DataView(payload);
        view.setUint32(0, numOperators, true); // Total operators (little-endian)
        view.setUint32(4, operatorsInChunk, true); // Operators in this chunk
        let offset = METADATA_SIZE;
        
        for (let i = 0; i < operatorsInChunk; i++) {
            const opIdx = startIdx + i;
            view.setUint32(offset, macEstimates[opIdx] || 0, true);
            view.setUint32(offset + 4, strideH[opIdx] || 0, true);
            view.setUint32(offset + 8, strideW[opIdx] || 0, true);
            view.setUint32(offset + 12, dilationH[opIdx] || 0, true);
            view.setUint32(offset + 16, dilationW[opIdx] || 0, true);
            view.setUint32(offset + 20, outputMagnitudes[opIdx] || 0, true);
            view.setUint32(offset + 24, readEstimates[opIdx] || 0, true);
            view.setUint32(offset + 28, writeEstimates[opIdx] || 0, true);
            view.setUint32(offset + 32, inputMagnitudes[opIdx] || 0, true);
            offset += OPERATOR_DATA_SIZE;
        }
        
        const header = new Uint8Array(13);
        const headerView = new DataView(header.buffer);
        headerView.setUint32(0, 0, true); // CRC32 not needed for config
        headerView.setUint8(4, DERIVED_ARRAYS_CMD);
        headerView.setUint32(5, chunkId, true); // chunk_id
        headerView.setUint32(9, totalChunks, true); // total_chunks
        
        const packet = new Uint8Array(header.length + payload.byteLength);
        packet.set(header, 0);
        packet.set(new Uint8Array(payload), header.length);
        
        const frameHeader = new Uint8Array([0x00, 0x02]); // Add 2-byte frame header for raw data
        const fullPacket = new Uint8Array(frameHeader.length + packet.length);
        fullPacket.set(frameHeader, 0);
        fullPacket.set(packet, frameHeader.length);
        
        console.log(`Sending chunk ${chunkId + 1}/${totalChunks}: ${operatorsInChunk} operators, ${payload.byteLength} bytes`);
        
        // Use the same handshake approach as model upload
        let sent = false;
        let retries = 0;
        const maxRetries = 5;
        
        while (!sent && retries < maxRetries) {
            try {
                console.log(`Attempt ${retries + 1}: Sending derived arrays chunk ${chunkId}`);
                await this.send(fullPacket);
                console.log(`Derived arrays chunk ${chunkId} sent, waiting for ACK...`);
                await this.waitForAck(chunkId, 2000);
                console.log(`Derived arrays chunk ${chunkId} ACK received successfully`);
                sent = true;
            } catch (e) {
                retries++;
                console.log(`Derived arrays chunk ${chunkId} attempt ${retries} failed: ${e}`);
                if (retries >= maxRetries) {
                    console.error(`Derived arrays chunk ${chunkId} failed after ${maxRetries} retries: ${e}`);
                    throw new Error(`Derived arrays chunk ${chunkId} failed after ${maxRetries} retries.`);
                }
            }
        }
    }
    
    console.log('All derived arrays chunks sent successfully');
    
    // Now send the string arrays
    await this.sendStringArrays(macStrings, outputShapes, filterShapes);
};

// Send string arrays to EVB (chunked)
serial.Port.prototype.sendStringArrays = async function(macStrings, outputShapes, filterShapes) {
    console.log('Sending string arrays to EVB...');
    const STRING_ARRAYS_CMD = 0x07; // New command type for string arrays
    const numOperators = macStrings.length;
    
    // Use simpler chunking for string arrays - fixed number of operators per chunk
    const CHUNK_SIZE = 480; // Same as derived arrays
    const METADATA_SIZE = 8; // total_ops (4) + chunk_ops (4)
    
    // Use a conservative fixed number of operators per chunk to avoid size issues
    const MAX_OPERATORS_PER_CHUNK = 8; // Fixed conservative value
    
    console.log(`String arrays chunking: total_ops=${numOperators}, max_ops_per_chunk=${MAX_OPERATORS_PER_CHUNK}`);
    
    const totalChunks = Math.ceil(numOperators / MAX_OPERATORS_PER_CHUNK);
    console.log(`Sending string arrays in ${totalChunks} chunks`);
    
    for (let chunkId = 0; chunkId < totalChunks; chunkId++) {
        const startIdx = chunkId * MAX_OPERATORS_PER_CHUNK;
        const endIdx = Math.min(startIdx + MAX_OPERATORS_PER_CHUNK, numOperators);
        const operatorsInChunk = endIdx - startIdx;
        
        console.log(`Sending string arrays chunk ${chunkId + 1}/${totalChunks}: operators ${startIdx}-${endIdx-1} (${operatorsInChunk} operators)`);
        
        // Calculate payload size for this chunk
        let chunkPayloadSize = METADATA_SIZE; // total_ops + chunk_ops
        
        for (let i = startIdx; i < endIdx; i++) {
            chunkPayloadSize += 12 + (macStrings[i] || "").length + (outputShapes[i] || "").length + (filterShapes[i] || "").length;
        }
        
        const payload = new ArrayBuffer(chunkPayloadSize);
        const view = new DataView(payload);
        let offset = 0;
        
        // Pack metadata
        view.setUint32(offset, numOperators, true); // total_operators
        offset += 4;
        view.setUint32(offset, operatorsInChunk, true); // operators_in_chunk
        offset += 4;
        
        // Pack strings for this chunk
        for (let i = startIdx; i < endIdx; i++) {
            // MAC string
            const macStr = macStrings[i] || "";
            view.setUint32(offset, macStr.length, true);
            offset += 4;
            for (let j = 0; j < macStr.length; j++) {
                view.setUint8(offset + j, macStr.charCodeAt(j));
            }
            offset += macStr.length;
            
            // Output shape string
            const outputStr = outputShapes[i] || "";
            view.setUint32(offset, outputStr.length, true);
            offset += 4;
            for (let j = 0; j < outputStr.length; j++) {
                view.setUint8(offset + j, outputStr.charCodeAt(j));
            }
            offset += outputStr.length;
            
            // Filter shape string
            const filterStr = filterShapes[i] || "";
            view.setUint32(offset, filterStr.length, true);
            offset += 4;
            for (let j = 0; j < filterStr.length; j++) {
                view.setUint8(offset + j, filterStr.charCodeAt(j));
            }
            offset += filterStr.length;
        }
        
        const header = new Uint8Array(13);
        const headerView = new DataView(header.buffer);
        headerView.setUint32(0, 0, true); // CRC32 not needed for config
        headerView.setUint8(4, STRING_ARRAYS_CMD);
        headerView.setUint32(5, chunkId, true); // chunk_id
        headerView.setUint32(9, totalChunks, true); // total_chunks
        
        const packet = new Uint8Array(header.length + payload.byteLength);
        packet.set(header, 0);
        packet.set(new Uint8Array(payload), header.length);
        
        const frameHeader = new Uint8Array([0x00, 0x02]); // Add 2-byte frame header for raw data
        const fullPacket = new Uint8Array(frameHeader.length + packet.length);
        fullPacket.set(frameHeader, 0);
        fullPacket.set(packet, frameHeader.length);
        
        console.log(`Sending string arrays chunk ${chunkId + 1}: ${operatorsInChunk} operators, ${payload.byteLength} bytes`);
        
        // Send with retry logic
        let sent = false;
        let retries = 0;
        const maxRetries = 5;
        
        while (!sent && retries < maxRetries) {
            try {
                console.log(`Attempt ${retries + 1}: Sending string arrays chunk ${chunkId + 1}`);
                await this.send(fullPacket);
                console.log(`String arrays chunk ${chunkId + 1} sent, waiting for ACK...`);
                await this.waitForAck(chunkId, 2000);
                console.log(`String arrays chunk ${chunkId + 1} ACK received successfully`);
                sent = true;
            } catch (e) {
                retries++;
                console.log(`String arrays chunk ${chunkId + 1} attempt ${retries} failed: ${e}`);
                if (retries >= maxRetries) {
                    console.error(`String arrays chunk ${chunkId + 1} failed after ${maxRetries} retries: ${e}`);
                    throw new Error(`String arrays chunk ${chunkId + 1} failed after ${maxRetries} retries.`);
                }
            }
        }
    }
    
    console.log('All string arrays chunks sent successfully');
};
})();