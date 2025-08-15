import { Model } from './dist/tflite.js';
import * as tflite from './dist/tflite.js';
import * as flatbuffers from './node_modules/flatbuffers/mjs/flatbuffers.js';

// Additional Attributes
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

// // Helper function to get node color based on operator type
// function getNodeColor(opName) {
//   const colorMap = {
//     // Convolutional layers - Blue shades
//     'CONV_2D': '#4A90E2',
//     'DEPTHWISE_CONV_2D': '#357ABD',
//     'TRANSPOSE_CONV': '#2E5C8A',
    
//     // Pooling layers - Green shades
//     'MAX_POOL_2D': '#7ED321',
//     'AVERAGE_POOL_2D': '#6BCB77',
//     'L2_POOL_2D': '#5AB95A',
    
//     // Activation functions - Orange shades
//     'RELU': '#F5A623',
//     'RELU6': '#F7B84B',
//     'TANH': '#FF8C00',
//     'SIGMOID': '#FF6B35',
//     'LEAKY_RELU': '#FFA500',
//     'HARD_SWISH': '#FF8A65',
//     'SOFTMAX': '#FF7043',
//     'LOG_SOFTMAX': '#FF5722',
    
//     // Arithmetic operations - Purple shades
//     'ADD': '#9B59B6',
//     'MUL': '#8E44AD',
//     'SUB': '#7D3C98',
//     'DIV': '#6C3483',
//     'MINIMUM': '#A569BD',
//     'MAXIMUM': '#BB8FCE',
    
//     // Fully connected layers - Red shades
//     'FULLY_CONNECTED': '#E74C3C',
//     'DENSE': '#C0392B',
    
//     // Normalization layers - Teal shades
//     'BATCH_NORM': '#1ABC9C',
//     'LAYER_NORM': '#16A085',
//     'LOCAL_RESPONSE_NORMALIZATION': '#138D75',
    
//     // Reshape operations - Gray shades
//     'RESHAPE': '#95A5A6',
//     'TRANSPOSE': '#7F8C8D',
//     'CONCATENATION': '#85929E',
//     'SPLIT': '#6C7B7F',
//     'SLICE': '#5D6D7E',
    
//     // Reduction operations - Brown shades
//     'MEAN': '#8B4513',
//     'SUM': '#A0522D',
//     'REDUCE_MAX': '#CD853F',
//     'REDUCE_MIN': '#DEB887',
    
//     // Special operations - Pink shades
//     'ARG_MAX': '#E91E63',
//     'ARG_MIN': '#C2185B',
//     'TOPK_V2': '#AD1457',
    
//     // Control flow - Dark colors
//     'IF': '#2C3E50',
//     'WHILE': '#34495E',
//     'CALL_ONCE': '#1B2631',
    
//     // Custom/Unknown - Gray
//     'CUSTOM': '#7F8C8D'
//   };
  
//   return colorMap[opName] || '#95A5A6'; // Default gray for unknown operators
// }

// Helper function to extract operator-specific attributes
function extractOperatorAttributes(op, model, subgraph, opName) {
  const attrs = [];
  
  // Get operator code for builtin code
  const opcodeIndex = op.opcodeIndex();
  const opcode = model.operatorCodes(opcodeIndex).builtinCode();
  
  // Add basic operator info
  attrs.push({ key: 'op_name', value: opName.toLowerCase() });
  attrs.push({ key: 'builtin_code', value: opcode.toString() });
  attrs.push({ key: 'operator_name', value: opName });
  
  // Extract input/output tensor info
  const inputIndices = op.inputsArray().filter(idx => idx !== -1);
  const outputIndices = op.outputsArray().filter(idx => idx !== -1);
  
  for (let i = 0; i < inputIndices.length; i++) {
    const tensor = subgraph.tensors(inputIndices[i]);
    if (tensor) {
      attrs.push({ 
        key: `input_${i}_shape`, 
        value: getTensorShape(tensor) 
      });
      attrs.push({ 
        key: `input_${i}_type`, 
        value: getTensorTypeName(tensor) 
      });
    }
  }
  
  for (let i = 0; i < outputIndices.length; i++) {
    const tensor = subgraph.tensors(outputIndices[i]);
    if (tensor) {
      attrs.push({ 
        key: `output_${i}_shape`, 
        value: getTensorShape(tensor) 
      });
      attrs.push({ 
        key: `output_${i}_type`, 
        value: getTensorTypeName(tensor) 
      });
    }
  }
  
  // Extract operator-specific options based on builtin code
  try {
    const builtinOptions = op.builtinOptions();
    if (builtinOptions) {
      switch (opcode) {
        case tflite.BuiltinOperator.CONV_2D:
          const conv2dOpts = tflite.Conv2DOptions.getRootAsConv2DOptions(builtinOptions);
          if (conv2dOpts) {
            attrs.push({ key: 'padding', value: conv2dOpts.padding().toString() });
            attrs.push({ key: 'stride_h', value: conv2dOpts.strideH().toString() });
            attrs.push({ key: 'stride_w', value: conv2dOpts.strideW().toString() });
            attrs.push({ key: 'dilation_h_factor', value: conv2dOpts.dilationHFactor().toString() });
            attrs.push({ key: 'dilation_w_factor', value: conv2dOpts.dilationWFactor().toString() });
            attrs.push({ key: 'fused_activation_function', value: conv2dOpts.fusedActivationFunction().toString() });
          }
          break;
          
        case tflite.BuiltinOperator.DEPTHWISE_CONV_2D:
          const depthwiseOpts = tflite.DepthwiseConv2DOptions.getRootAsDepthwiseConv2DOptions(builtinOptions);
          if (depthwiseOpts) {
            attrs.push({ key: 'padding', value: depthwiseOpts.padding().toString() });
            attrs.push({ key: 'stride_h', value: depthwiseOpts.strideH().toString() });
            attrs.push({ key: 'stride_w', value: depthwiseOpts.strideW().toString() });
            attrs.push({ key: 'depth_multiplier', value: depthwiseOpts.depthMultiplier().toString() });
            attrs.push({ key: 'fused_activation_function', value: depthwiseOpts.fusedActivationFunction().toString() });
          }
          break;
          
        case tflite.BuiltinOperator.MAX_POOL_2D:
        case tflite.BuiltinOperator.AVERAGE_POOL_2D:
          const poolOpts = tflite.Pool2DOptions.getRootAsPool2DOptions(builtinOptions);
          if (poolOpts) {
            attrs.push({ key: 'padding', value: poolOpts.padding().toString() });
            attrs.push({ key: 'stride_h', value: poolOpts.strideH().toString() });
            attrs.push({ key: 'stride_w', value: poolOpts.strideW().toString() });
            attrs.push({ key: 'filter_h', value: poolOpts.filterHeight().toString() });
            attrs.push({ key: 'filter_w', value: poolOpts.filterWidth().toString() });
            attrs.push({ key: 'fused_activation_function', value: poolOpts.fusedActivationFunction().toString() });
          }
          break;
          
        case tflite.BuiltinOperator.FULLY_CONNECTED:
          const fcOpts = tflite.FullyConnectedOptions.getRootAsFullyConnectedOptions(builtinOptions);
          if (fcOpts) {
            attrs.push({ key: 'fused_activation_function', value: fcOpts.fusedActivationFunction().toString() });
            attrs.push({ key: 'weights_format', value: fcOpts.weightsFormat().toString() });
          }
          break;
          
        case tflite.BuiltinOperator.ADD:
        case tflite.BuiltinOperator.MUL:
        case tflite.BuiltinOperator.SUB:
        case tflite.BuiltinOperator.DIV:
          const arithmeticOpts = tflite.ArithmeticOptions.getRootAsArithmeticOptions(builtinOptions);
          if (arithmeticOpts) {
            attrs.push({ key: 'fused_activation_function', value: arithmeticOpts.fusedActivationFunction().toString() });
          }
          break;
          
        case tflite.BuiltinOperator.RELU:
        case tflite.BuiltinOperator.RELU6:
        case tflite.BuiltinOperator.TANH:
        case tflite.BuiltinOperator.SIGMOID:
          const activationOpts = tflite.ActivationFunctionType.getRootAsActivationFunctionType(builtinOptions);
          if (activationOpts) {
            attrs.push({ key: 'activation_type', value: activationOpts.toString() });
          }
          break;
      }
    }
  } catch (e) {
    // Ignore errors for unsupported options
    console.log(`Could not extract options for operator ${opName}:`, e.message);
  }
  
  return attrs;
}

export async function parseTFLiteFlatbufferToGraph(buffer, filename = 'model.tflite') {
  const bb = new flatbuffers.ByteBuffer(new Uint8Array(buffer));
  const model = Model.getRootAsModel(bb);
  const subgraph = model.subgraphs(0);

  const nodes = [];
  const tensorToNode = new Map(); // Track which node produces each tensor

  for (let i = 0; i < subgraph.operatorsLength(); i++) {
    const op = subgraph.operators(i);
    const opcodeIndex = op.opcodeIndex();
    const opcode = model.operatorCodes(opcodeIndex).builtinCode();

    const opName = tflite.BuiltinOperator[opcode] || 'CUSTOM';

    const inputIndices = op.inputsArray().filter(idx => idx !== -1);
    const outputIndices = op.outputsArray().filter(idx => idx !== -1);

    const nodeId = `node_${i}`;
    
    // Create incoming edges based on actual tensor connections
    const incomingEdges = [];
    for (let inputIdx = 0; inputIdx < inputIndices.length; inputIdx++) {
      const tensorIndex = inputIndices[inputIdx];
      const sourceNodeId = tensorToNode.get(tensorIndex);
      
      if (sourceNodeId) {
        incomingEdges.push({
          sourceNodeId: sourceNodeId,
          sourceNodeOutputId: '0', // Assuming single output per node for now
          targetNodeInputId: `${inputIdx}`
        });
      }
    }

    // Extract detailed attributes
    const detailedAttrs = extractOperatorAttributes(op, model, subgraph, opName);
    
    // Add basic attributes
    detailedAttrs.push(
      { key: 'index', value: i.toString() },
      { key: 'filename', value: filename }
    );

    // Extract namespace from output tensor names
    let namespace = '';
    for (const outputIndex of outputIndices) {
      const tensor = subgraph.tensors(outputIndex);
      if (tensor && tensor.name()) {
        const tensorName = tensor.name();
        // Extract namespace from tensor name (e.g., "EfficientNetV2/stem.conv/Conv2D" -> "EfficientNetV2/stem.conv")
        const parts = tensorName.split('/');
        if (parts.length > 1) {
          namespace = parts.slice(0, -1).join('/');
          break;
        }
      }
    }

    const node = {
      id: nodeId,
      label: `${opName} (${i})`,
      namespace: namespace,
      attrs: detailedAttrs,
      incomingEdges: incomingEdges,
    };

    // Add inputsMetadata with proper tensor information
    if (inputIndices.length > 0) {
      node.inputsMetadata = [];
      for (let j = 0; j < inputIndices.length; j++) {
        const inputTensor = subgraph.tensors(inputIndices[j]);
        const inputAttrs = [];
        
        if (inputTensor) {
          // Add tensor name
          if (inputTensor.name()) {
            inputAttrs.push({ key: 'tensor_name', value: inputTensor.name() });
          }
          
          // Add shape
          inputAttrs.push({ key: 'shape', value: getTensorShape(inputTensor) });
          
          // Add type
          inputAttrs.push({ key: 'type', value: getTensorTypeName(inputTensor) });
          
          // Add quantization info if available
          if (inputTensor.quantization()) {
            const quant = inputTensor.quantization();
            if (quant.scale() && quant.scale().length() > 0) {
              inputAttrs.push({ key: 'quantization_scale', value: quant.scale(0).toString() });
            }
            if (quant.zeroPoint() && quant.zeroPoint().length() > 0) {
              inputAttrs.push({ key: 'quantization_zero_point', value: quant.zeroPoint(0).toString() });
            }
          }
          
          // Add tensor index
          inputAttrs.push({ key: 'tensor_index', value: inputIndices[j].toString() });
        }
        
        node.inputsMetadata.push({
          id: `${j}`,
          attrs: inputAttrs
        });
      }
    }

    // Add outputsMetadata with proper tensor information
    if (outputIndices.length > 0) {
      node.outputsMetadata = [];
      for (let j = 0; j < outputIndices.length; j++) {
        const outputTensor = subgraph.tensors(outputIndices[j]);
        const outputAttrs = [];
        
        if (outputTensor) {
          // Add tensor name
          if (outputTensor.name()) {
            outputAttrs.push({ key: 'tensor_name', value: outputTensor.name() });
          }
          
          // Add shape
          outputAttrs.push({ key: 'shape', value: getTensorShape(outputTensor) });
          
          // Add type
          outputAttrs.push({ key: 'type', value: getTensorTypeName(outputTensor) });
          
          // Add quantization info if available
          if (outputTensor.quantization()) {
            const quant = outputTensor.quantization();
            if (quant.scale() && quant.scale().length() > 0) {
              outputAttrs.push({ key: 'quantization_scale', value: quant.scale(0).toString() });
            }
            if (quant.zeroPoint() && quant.zeroPoint().length() > 0) {
              outputAttrs.push({ key: 'quantization_zero_point', value: quant.zeroPoint(0).toString() });
            }
          }
          
          // Add tensor index
          outputAttrs.push({ key: 'tensor_index', value: outputIndices[j].toString() });
        }
        
        node.outputsMetadata.push({
          id: `${j}`,
          attrs: outputAttrs
        });
      }
    }

    nodes.push(node);

    // Track which tensors this node produces
    for (const outputIndex of outputIndices) {
      tensorToNode.set(outputIndex, nodeId);
    }
  }

  const result = [
    {
      label: `TFLite FlatBuffer Model (${filename})`,
      graphs: [
        {
          id: 'tflite_graph',
          nodes: nodes
        }
      ]
    }
  ];

  console.log('Generated graph structure:', JSON.stringify(result, null, 2));
  return result;
}

// If loaded directly on model-explorer.html
if (window.location.pathname.includes('model-explorer.html')) {
  const urlParams = new URLSearchParams(window.location.search);
  const modelUrl = urlParams.get('modelUrl');
  const filename = urlParams.get('filename') || 'model.tflite';

  if (modelUrl) {
    fetch(modelUrl)
      .then(r => r.arrayBuffer())
      .then(async (buf) => {
        const graphCollections = await parseTFLiteFlatbufferToGraph(buf, filename);
        const visualizer = document.createElement('model-explorer-visualizer');
        visualizer.graphCollections = graphCollections;
        document.getElementById('content').innerHTML = '';
        document.getElementById('content').appendChild(visualizer);
      });
  }
}