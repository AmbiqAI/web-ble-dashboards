/****************************************************************************************
 *
 * @file logs.js
 *
 * @brief Useful functions for debugging.
 *
 * Copyright (C) Ambiq Micro
 *
 *
 ****************************************************************************************
 */

/**
 * @brief Display logs on the web.
 */
function log(e)
{
    document.querySelector("#logs").textContent += `${e}\r\n`
}
