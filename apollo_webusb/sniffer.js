/****************************************************************************************
 *
 * @file sniffer.js
 *
 * @brief Capture audio data from MCU to PC
 *
 * Copyright (C) Ambiq Micro
 *
 *
 ****************************************************************************************
 */

/**
 * @brief Macros for converting a big endian byte stream to object
 * @param msg The big endian byte stream.
 * @param obj The object.
 */
function BSTREAM_TO_OBJECT(msg, obj)
{
    let offset = 0;
    for (let prop in obj)
    {
        let array = obj[prop];
        let size  = array.BYTES_PER_ELEMENT * array.length;
        for (let i = 0; i < size; i++)
        {
            array[i] = msg[offset + i];
        }
        offset += size;
    }
}

/**
 * @brief Separate the intertwined data into separate raw files.
 * @param buf The array buffer.
 * @param path The path of raw file storage.
*/
async function binToRaw(buf, path)
{
    // Convert buf to string
    let str = "";
    for (let i = 0; i < buf.byteLength; i++)
    {
        str += String.fromCharCode(buf[i]);
    }
    console.log("str.length " + str.length);
    console.log("str " + str);
}

async function binToRaw_orig(buf, path)
{
    // It supports capturing data from up to seven nodes at the same time
    let fileNameList =
        [ "file1", "file2", "file3", "file4", "file5", "file6", "file7" ];
    let   fileHandleList = [];
    const rawStreamList  = [];
    let   fileNameNum    = 0;
    let   raw_msg        = {
        pn_media : new Uint8Array(1), /**< Media type (link-layer identifier) */
        pn_rdev : new Uint8Array(1), /**< Receiver device ID */
        pn_sdev : new Uint8Array(1), /**< Sender device ID */
        pn_res : new Uint8Array(1),  /**< Resource ID or function */
        pn_length :
            new Uint8Array(2), /**< Big-endian message byte length (minus 6) */
        pn_robj : new Uint8Array(1), /**< Receiver object ID */
        pn_sobj : new Uint8Array(1), /**< Sender object ID */

        trans_id : new Uint8Array(1), /**< Transaction id */
        msg_id : new Uint8Array(1),   /**< Message id */

        dir : new Uint8Array(1),   /**< Input data or output data */
        index : new Uint8Array(1), /**< Node index */
        mode : new Uint8Array(1),  /**< Audio mode: stereo or mono */
        sample_rate : new Uint8Array(2), /**< Specific sample rate, bit field */
        length : new Uint8Array(2), /**< Pcm data length */
    };

    // count raw_msg size
    let audio_msg_size = 0;
    for (let prop in raw_msg)
    {
        let array = raw_msg[prop];
        audio_msg_size += array.BYTES_PER_ELEMENT * array.length;
    }

    let frameStart = 0;
    let frameEnd   = audio_msg_size;
    while (frameEnd <= buf.byteLength)
    {
        // Read audio message from the buffer
        let msg = new Uint8Array(buf.slice(frameStart, frameEnd));
        BSTREAM_TO_OBJECT(msg, raw_msg);

        if ((raw_msg.pn_rdev[0] == MSG_EP_AGENT.DSP) &&
            (raw_msg.pn_sdev[0] == MSG_EP_AGENT.DSP))
        {
            // Determine whether it is raw data
            if (raw_msg.msg_id[0] == HAL_Audio_Node_Data_Notify)
            {
                let strSobj  = raw_msg.pn_sobj[0].toString();
                let strDir   = raw_msg.dir[0].toString();
                let strIndex = raw_msg.index[0].toString();
                let strMode  = raw_msg.mode[0].toString();

                let sampleRate = new Uint16Array(1);
                BSTREAM_TO_UINT16(raw_msg.sample_rate, sampleRate);
                let strSampleRate = sampleRate[0].toString();

                // Combined into a file name
                let fileName = strSobj + "_" + strDir + "_" + strIndex + "_" +
                               strMode + "_" + strSampleRate + ".pcm";

                let fileFlag     = 0;
                let audioDataLen = new Uint16Array(1);
                BSTREAM_TO_UINT16(raw_msg.length, audioDataLen);
                let audioData = new Uint8Array(
                    buf.slice(frameEnd, frameEnd + audioDataLen[0]));

                for (let i = 0; i < fileNameList.length; i++)
                {
                    if (fileName == fileNameList[i])
                    {
                        if (rawStreamList[i])
                        {
                            await rawStreamList[i].write(audioData);
                            break;
                        }
                        else
                        {
                            console.log("Failed to create " + fileName);
                        }
                    }

                    // fileName isn't in the fileNameList, so creat one new
                    // file.
                    if (i == (fileNameList.length - 1))
                    {
                        fileFlag = 1;
                    }
                }

                // Creat one new file
                if (fileFlag)
                {
                    fileNameList[fileNameNum]   = fileName;
                    fileHandleList[fileNameNum] = await path.getFileHandle(
                        fileNameList[fileNameNum], {create : true});
                    rawStreamList[fileNameNum] =
                        await fileHandleList[fileNameNum].createWritable();
                    if (rawStreamList[fileNameNum])
                    {
                        await rawStreamList[fileNameNum].write(audioData);
                    }
                    fileNameNum++;
                }
            }
        }
        else
        {
            log("audio.bin file has bad frame, the location in " + frameStart +
                " bytes.");
            break;
        }

        let len = new Uint16Array(1);
        // raw_msg.pn_length is the length of (frame - 6).
        BSTREAM_TO_UINT16(raw_msg.pn_length, len);
        len[0] += PHONET_LEN_OFFSET;
        frameStart += len[0];
        frameEnd += len[0];
    }

    // Close raw file
    for (let i = 0; i < fileNameNum; i++)
    {
        if (rawStreamList[i])
        {
            await rawStreamList[i].close();
            console.log("rawStreamList close " + rawStreamList[i]);
        }
    }

    log("Parsing ends.")
    console.log("buf.byteLength " + buf.byteLength);
};
