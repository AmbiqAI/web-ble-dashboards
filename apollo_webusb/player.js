/****************************************************************************************
 *
 * @file player.js
 *
 * @brief Music playback from PC to MCU
 *
 * Copyright (C) Ambiq Micro
 *
 *
 ****************************************************************************************
 */

/**
 * @brief Play music through the regular transmission of raw file data.
 * @param file The array buffer.
 * @param port The port of serial
 * @param interval The timer.
 */
function playFile(file, port, interval)
{
    // channel: 1 , sample rate: 16k, bit width: 16 bit.
    let intervalTime  = 16; // ms
    let frameTypeSize = 2;
    let audioDataSize = 512 - frameTypeSize;
    let frameSize =
        audioDataSize + frameTypeSize; // WebUSB transfers a maximum of 512 at a
                                       // time in high speed.
    let frameType = new Uint8Array(frameTypeSize);
    UINT16_TO_BSTREAM(FRAME_TYPE.AUDIO_DATA, frameType);
    let frame = new Uint8Array(frameSize);

    let audioDataStar = 0;
    let audioDataEnd  = audioDataSize;

    // Set a timer
    interval.id = setInterval(function() {
        console.log(interval.id);
        if (port)
        {
            let data = file.slice(audioDataStar, audioDataEnd);

            // Add frame header for audio data
            let tempData = new Uint8Array(data);
            frame.set(frameType, 0);
            frame.set(tempData, frameType.length);
            console.log(frame);
            port.send(frame);
            if (data.byteLength < audioDataSize)
            {
                // Stop the timer
                clearInterval(interval.id);
                interval.id = null;
                log("Audio playback ends.")
            }
        }

        audioDataStar += audioDataSize;
        audioDataEnd += audioDataSize;
    }, intervalTime);
}
