//*****************************************************************************
//
//! @file application.js
//!
//! @brief Handle web operation.
//!
//
//*****************************************************************************

(function() {
'use strict';

/* Static or global variables */
window.file  = null;
let interval = {id : 0};

document.addEventListener('DOMContentLoaded', event => {
    let connectButton = document.querySelector("#connect");
    let statusDisplay = document.querySelector('#status');
    let port;

    /**
     * @brief Connect PC with MCU through WebUSB
     *
     */
    function connect()
    {
        port.connect().then(
            () => {
                statusDisplay.textContent = '';
                connectButton.textContent = 'Disconnect';

                // Invoked when port recive data
                port.onReceive = data => {
                    // Write data to file
                    console.log("data.byteLength " + data.byteLength);
                    writeBuf(data);
                };
                port.onReceiveError = error => {
                    console.error(error);
                };
            },
            error => {
                statusDisplay.textContent = error;
            });
    }

    // Invoked when connect Button is clicked
    connectButton.addEventListener('click', function() {
        if (port)
        {
            port.disconnect();
            connectButton.textContent = 'Connect';
            statusDisplay.textContent = '';
            port                      = null;
        }
        else
        {
            serial.requestPort()
                .then(selectedPort => {
                    port = selectedPort;
                    // Connect Audio Tool with MCU
                    connect();
                })
                .catch(error => {
                    statusDisplay.textContent = error;
                });
        }
    });

    // Invoked when Send Button is clicked
    document.querySelector("#gain_send").onclick = () => {
        // Gain
        let gain_db = document.querySelector("#gain").value;
        setGain(gain_db, port);
    };

    // Invoked when Send Button is clicked
    document.querySelector("#drc_send").onclick = () => {
        // Drc Parameters
        let drcAttackTime = document.querySelector("#DrcAttackTime").value;
        let drcDecayTime  = document.querySelector("#DrcDecayTime").value;
        let drcKneeThreshold =
            document.querySelector("#DrcKneeThreshold").value;
        let drcNoiseGate = document.querySelector("#DrcNoiseGate").value;
        let drcSlope     = document.querySelector("#DrcSlope").value;
        setDrc(port, drcAttackTime, drcDecayTime, drcKneeThreshold,
               drcNoiseGate, drcSlope);
    };

    // Invoked when Send Button is clicked
    document.querySelector("#agc_send").onclick = () => {
        // Agc Parameters
        let agcAttackTime = document.querySelector("#AgcAttackTime").value;
        let agcDecayTime  = document.querySelector("#AgcDecayTime").value;
        let agcTarget     = document.querySelector("#AgcTarget").value;
        setAgc(port, agcAttackTime, agcDecayTime, agcTarget);
    };

    // Invoked when Send Button is clicked
    document.querySelector("#peq_ul_send").onclick = () => {
        // PEQ Parameters
        let dir            = "uplink";
        let bandNumber     = document.querySelector("#BandNumber").value;
        let bandCenterFreq = document.getElementsByName("band_center_freq");
        let bandQfactor    = document.getElementsByName("band_qfactor");
        let bandGain       = document.getElementsByName("band_gain");
        setPeq(port, dir, bandNumber, bandCenterFreq, bandQfactor, bandGain);
    };

    // Invoked when Send Button is clicked
    document.querySelector("#peq_dl_send").onclick = () => {
        // PEQ Parameters
        let dir            = "downlink";
        let bandNumber     = document.querySelector("#BandNumber").value;
        let bandCenterFreq = document.getElementsByName("band_center_freq");
        let bandQfactor    = document.getElementsByName("band_qfactor");
        let bandGain       = document.getElementsByName("band_gain");
        setPeq(port, dir, bandNumber, bandCenterFreq, bandQfactor, bandGain);
    };

    // Invoked when Send Button is clicked
    document.querySelector("#sniffer_send").onclick = () => {
        // Sniffer Audio Data
        let audio = document.getElementsByName("audio");
        setSniffer(port, audio);
    };

    const selectPathButton   = document.querySelector("#select_path_button");
    const startCaptureButton = document.querySelector("#start_capture_button");
    const stopCaptureButton  = document.querySelector("#stop_capture_button");
    const parseBinFileButton = document.querySelector("#parse_bin_file_button");
    const startPlayButton    = document.querySelector("#start_play_button");
    const stopPlayButton     = document.querySelector("#stop_play_button");

    // Disable Button
    startCaptureButton.disabled = !0;
    stopCaptureButton.disabled  = !0;

    // Invoked when Select Path Button is clicked
    selectPathButton.addEventListener(
        "click", (async () => {
            const directoryHandle = await window.showDirectoryPicker();
            const fileHandle      = await directoryHandle.getFileHandle(
                "audio.bin", {create : true});
            file = await fileHandle.createWritable();

            window.file                 = file;
            startCaptureButton.disabled = !1;
            log("The path of audio data has been selected.")
        }))

    // Invoked when Start Capture Button is clicked
    startCaptureButton.addEventListener("click", (() => {
                                            if (window.file)
                                            {
                                                snifferActive(port, true);
                                                stopCaptureButton.disabled = !1;
                                            }
                                        }))

    // Invoked when Stop Capture Button is clicked
    stopCaptureButton.addEventListener(
        "click", (() => {
            if (window.file)
            {
                window.file.close();
                window.file = null;
            }

            // Stop capturing data
            snifferActive(port, false);
            stopCaptureButton.disabled = !0,
            log("Your microphone audio has been successfully sniffed locally.")
        }))

    // Invoked when Parse Bin File Button is clicked
    parseBinFileButton.addEventListener(
        "click", (async () => {
            const binFile    = document.getElementById('bin_file');
            const pathHandle = await window.showDirectoryPicker();

            const file   = binFile.files[0];
            const reader = new FileReader();

            if (!file)
            {
                console.log("Please add bin file");
                return;
            }

            // File read complete
            reader.onload = () => {
                console.log(reader.result);
                // Parse bin file to pcm file
                binToRaw(reader.result, pathHandle);
            };
            reader.readAsArrayBuffer(file);
        }))

    // Invoked when Start Play Button is clicked
    startPlayButton.addEventListener(
        "click", (() => {
            const binFile = document.getElementById('pcm_file');
            const file    = binFile.files[0];
            if (!file)
            {
                console.log("Please add pcm file");
                return;
            }

            const reader = new FileReader();
            // File read complete
            reader.onload = () => {
                console.log(reader.result);
                // Play pcm file
                playFile(reader.result, port, interval);
            };
            reader.readAsArrayBuffer(file);
        }))

    // Invoked when Stop Play Button is clicked
    stopPlayButton.addEventListener("click", (() => {
                                        clearInterval(interval.id);
                                        interval.id = null;
                                    }))

    // Print promise rejection
    window.onunhandledrejection = e => {
        log(`> ${e.reason}`);
    };

    // Print global error
    window.onerror = e => {
        log(`> ${e}`);
    };
});   // DOMContentLoaded
})(); // function()
