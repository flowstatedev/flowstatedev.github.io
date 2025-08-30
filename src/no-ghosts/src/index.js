import { Decoder, MesgDefinition, Stream, CrcCalculator } from "@garmin/fitsdk";

/**
 * 
 * @param {string} filename filename to parse
 * @returns {[string, string]?} [basename, extension] or null hte filename could not be parsed
 */
function getBasenameAndExt(filename) {
  if (!filename) {
    return null;
  }

  const re = /(?:\.([^.]+))?$/;
  const result = re.exec(filename);
  if (!result) return null;
  return [filename.substring(0, result.index), filename.substring(result.index)];
}

/**
 * 
 * @param {string} name parameter name
 * @param {string} [url] the url to parse (by default, use the current location)
 * @returns {string?} the parameter value or null if the param does not exist
 */
function getParameterByName(name, url) {
  url = url || window.location.href
  name = name.replace(/[[\]]/g, '\\$&');
  var regex = new RegExp('[?&]' + name + '(=([^&#]*)|&|#|$)'),
      results = regex.exec(url);
  if (!results) return null;
  if (!results[2]) return '';
  return decodeURIComponent(results[2].replace(/\+/g, ' '));
}

// TODO: consider making AppError class for all app errors,
//  so the UI can treat app errors and unanticipated errors
//  differently (like show a more severe alert colour for the latter)
//  
//  Consider having different messages for internal and external use
//  (beyond the class name prefix which will still be shown if you log the object).
//  Kind of a slippery slope tho. Only point is to make the console output look
//  nicer by removing whatever's redundant in the message given that the class
//  name will also be printed, but it doesn't matter
//  e.g.
//  console: "FITDecoderError: FIT Decoder returned errors:..."
//  UI: "FIT Decoder returned errors:..."
//  
//  What really matters is that the text in the UI looks nice and the text in the
//  console is accurate

/**
 * @summary Error with a custom toString() method which excludes the usual CLASSNAME: prefix
 * @description When you need a friendly message for the UI, while still allowing the UI to print the class name for unanticipated errors
 */
// TODO think of better name than this
class CustomError extends Error {
  /**
   * 
   * @param {string} message 
   */
  constructor(message) {
    super(message);
    // this.name = this.constructor.name;
    // this.name = 'CustomError';
    this.name = 'Error';
  }

  toString() {
    // return super.toString();
    return this.message;
  }
}

/**
 * thrown when the given file is a fit file, but not an activity profile,
 * due to the absence of a certain message
 */
class NotActivityProfileError extends CustomError {
  /**
   * 
   * @param {string} message 
   */
  constructor(message) {
    super(message);
    // this.name = this.constructor.name;
    this.name = 'NotActivityProfileError';
  }
}

/**
 * thrown when the given file is a fit file, but not an activity profile,
 * due to the wrong FIT file type (i.e. not 'sport')
 */
class NotActivityProfileGenericError extends CustomError {
  /**
   * 
   * @param {string} message 
   * @param {string} fitType e.g. 'sport'
   */
  constructor(message, fitType) {
    super(message);
    // this.name = this.constructor.name;
    this.name = 'NotActivityProfileGenericError';
    /** @type {string} */
    this.fitType = fitType;
  }
}
class FITDecoderError extends CustomError {
  /**
   * 
   * @param {CustomError[]} errors errors array from garmin FITDecoder
   * @param {string} [message] optional custom error meesge
   */
  constructor(errors, message) {
    message = message || 'FIT file is corrupt:';
    message = `${message}:\n${
      errors.reduce((acc, val) => acc + `• ${val.message}\n`, '')
    }`;
    super(message);

    // somewhat redundant
    // errors.forEach(e => console.error(e));

    this.name = 'FITDecoderError';
    // this.name = this.constructor.name;
    /** @type {CustomError[]} */
    this.errors = errors
  }
}

class FITMessageNotFound extends CustomError {
  /**
   * 
   * @param {number} messageNumber 
   * @param {string} [tag] 
   */
  constructor(messageNumber, tag) {
    super(`FIT message ${messageNumber} not found`);
    // this.name = this.constructor.name;
    this.name = 'FITMessageNotFound';
    /** @type {number} */
    this.messageNumber = messageNumber;
    /** @type {string | undefined} */
    this.tag = tag;
  }
}

class FITFieldNotFound extends CustomError {
  /**
   * 
   * @param {number} messageNumber 
   * @param {number} fieldNumber
   * @param {string} [tag] 
   */
  constructor(messageNumber, fieldNumber, tag) {
    super(`FIT message ${messageNumber} field ${fieldNumber} not found`);
    // this.name = this.constructor.name;
    this.name = 'FITFieldNotFound';
    /** @type {number} */
    this.messageNumber = messageNumber;
    /** @type {number} */
    this.fieldNumber = fieldNumber;
    /** @type {string | undefined} */
    this.tag = tag;
  }
}

// A class which defines an in-place edit to a FIT file
// (simply replacing one value with another without making any other changes)
class FITEditDefinition {
  /**
   * 
   * @param {number} msgNum the global FIT message number
   * @param {number} fieldNum the field number
   * @param {number} fieldSize the field size (currently only 1 is supported, lame ik)
   * @param {(val: number) => number?} editFn function which maps the existing value of the field to the new value - return null/undefined or the same value to avoid making changes
   * @param {string} [tag] a name to identify this edit (will be returned in the event of an error)
   */
  constructor(msgNum, fieldNum, fieldSize, editFn, tag) {
    this.tag = tag;
    this.msgNum = msgNum;
    this.fieldNum = fieldNum;
    this.fieldSize = fieldSize;
    this.editFn = editFn;

    if (fieldSize !== 1) {
      throw new Error("FITEditDefinition only supports field of size 1 for now"); // TODO
    }

    // this.foundMsgDefinition = false
    // this.foundFieldDefinition = false
    this.numberOfInstances = 0; // TODO consider removing this
    this.numberOfEdits = 0; // TODO consider removing this
  }
}

class FieldInfo {
  /**
   * 
   * @param {number} fieldNum field number
   */
  constructor(fieldNum) {
    /** @type {number} */
    this.fieldNum = fieldNum;
    /**
     * the number or string that the FIT decoder will use
     * to refer to this field in the message data
     * (if it's defined in the profile, it will be a string,
     * otherwise it will be a number :/)
     * @type {(number|string)?}
     */
    this.fieldID = null;
    /** 
     *  0-based offset from the beginning of the message data 
     *  @type {number?}
     */
    this.messageOffset = null;

    /** @type {number[]} */
    this.fileOffsets = [];

    /** @type {number} */
    this.numberOfEdits = 0;
  }
}
class MessageInfo {
  /**
   * 
   * @param {number} globalMsgNum 
   */
  constructor(globalMsgNum) {
    /** @type {number} */
    this.globalMsgNum = globalMsgNum
    /** @type {number?} */
    this.messageSize = null

    /**
     * maps field number to FieldInfo?
     *  @type {{[key: number]: FieldInfo}} 
     */
    this.fieldsToEdit = {}

    /** @type {number} */
    this.numberOfInstances = 0
  }
}

/**
 * 
 * @returns {boolean}
 */
function isDebugging() {
  return getParameterByName('debug') != null;
}

/**
 * 
 * @param  {...any} args args will be passed to console.log
 */
function debugLog(...args) {
  isDebugging() && console.log(...args);
}

/* eslint-disable-next-line jsdoc/require-returns-check */
/**
 * 
 * @param {ArrayBuffer} buffer FIT file data
 * @param {string} expectedFileType FIT file type (e.g. 'sport' aka activity profile)
 * @param {FITEditDefinition[]} requestedEdits edits to make to the FIT file
 * @returns {{ fitType: string; numberOfEdits: number; editedMessages: { [key: number]: MessageInfo; }}}
 */
function editFITFile(buffer, expectedFileType, requestedEdits) {
  const stream = Stream.fromByteArray(buffer);

  const decoder = new Decoder(stream); 
  if (!decoder.isFIT()) {
    throw new CustomError("This is not a FIT file");
  }

  if (decoder.checkIntegrity()) {
    console.log("file CRC is valid");
  } else {
    console.warn("file CRC is invalid");
  }

  /**
   * maps global message number to MessageInfo
   *  @type {{[key: number]: MessageInfo}} 
   */
  const messagesToEdit = {};

  /**
   * @type {Array<MesgDefinition>}
   */
  const messageDefinitions = [];

  requestedEdits.forEach(edit => {
    const messageToEdit = messagesToEdit[edit.msgNum] || new MessageInfo(edit.msgNum);
    messageToEdit.fieldsToEdit[edit.fieldNum] = messageToEdit.fieldsToEdit[edit.fieldNum] || new FieldInfo(edit.fieldNum);
    messagesToEdit[edit.msgNum] = messageToEdit;
  });

  const onMesgDefinition = (mesgDefinition) => {
    messageDefinitions.push(mesgDefinition);

    const messageToEdit = messagesToEdit[mesgDefinition.globalMessageNumber];
    if (messageToEdit) {
      console.log(`• Found message definition ${mesgDefinition.globalMessageNumber}`)
      debugLog(mesgDefinition);

      messageToEdit.messageSize = mesgDefinition.messageSize

      let offset = 0;
      for (let i = 0; i < mesgDefinition.fieldDefinitions.length; i++) {
        const def = mesgDefinition.fieldDefinitions[i];

        const fieldToEdit = messageToEdit.fieldsToEdit[def.fieldDefinitionNumber];
        if (fieldToEdit) {
          fieldToEdit.messageOffset = offset;

          // For each field that we need to access in upcoming
          // onMesg() calls, we need an object index.
          //
          // unfortunately the garmin sdk uses the name as the object index
          // for fields defined in the profile, and the field definition
          // number for undefined fields
          //
          // see: @garmin/fitsdk/src/decoder.js#readFieldValue
          // (latest as of this comment) https://github.com/garmin/fit-javascript-sdk/blob/1f7d035e4f6cce662e38562c15b8e1f0c6602123/src/decoder.js#L474
          //
          // this means that the index could change, in the extremely
          // unlikely event that the message is added to the profile in
          // te future
          //
          //
          // there is no way to normalize this behaviour or to
          // directly look up a field with a given definition number,
          // for a given message
          //
          // so to try to futureproof our code we will have to literally hardcode
          // the same index logic as the sdk
          //
          // in reality it's moot bc this message will never be added to the profile.
          // but it's another example of a not-so-great design...
          fieldToEdit.fieldID = def.name || def.fieldDefinitionNumber;

          console.log(`field ${def.fieldDefinitionNumber}: offset = ${fieldToEdit.messageOffset}, id = ${fieldToEdit.fieldID}`);
        }
        offset += def.size;
      }
    }
  }

  let numFieldInstances = 0;
  const onMesg = (messageNumber, message) => {
    const messageToEdit = messagesToEdit[messageNumber];
    if (messageToEdit) {
      console.log(`• Found message ${messageNumber}`);
      debugLog(message);

      if (messageToEdit.messageSize === null) {
        // caught by Garmin
        throw new Error(`found message ${messageNumber} data before definition`);
      }

      messageToEdit.numberOfInstances++;

      for (const fieldNum in messageToEdit.fieldsToEdit) {
        const fieldToEdit = messageToEdit.fieldsToEdit[fieldNum];
        if (fieldToEdit.messageOffset === null) {
          // caught by Garmin
          throw new Error(`found message ${messageNumber} field ${fieldNum} data without field definition`);
        }

        // - the stream is positioned right after the current message.
        // - stream.position - messageToEdit.messageSize is the start of the message data
        // (not including the 1 byte header)
        const offsetToUse = stream.position - messageToEdit.messageSize + fieldToEdit.messageOffset;

        fieldToEdit.fileOffsets.push(offsetToUse);
        numFieldInstances++;
        console.log(`Found field ${fieldNum} at file offset ${offsetToUse}`);
      }
    }
  };

  const {messages, errors} = decoder.read({
    includeUnknownData: true,
    mesgListener: onMesg,
    mesgDefinitionListener: onMesgDefinition,
  });

  debugLog('• Message definitions:');
  debugLog(messageDefinitions);

  debugLog('• Messages:');
  debugLog(messages);
  if (errors.length) {
    throw new FITDecoderError(errors);
  }

  let numberOfEdits = 0;
  /** @type {string} */
  let fitType;

  try {
    fitType = messages['fileIdMesgs'][0]['type'];
  } catch (e) {
    throw new Error(`could not determine FIT file type: ${e.message}`);
  }

  try {
    console.log(`FIT type = ${fitType}`)
    if (fitType !== expectedFileType) {
      // @eslint-disable-next-line
      // @ts-ignore
      return; // skip to finally {}
    }

    if (numFieldInstances === 0) {
      console.log(`no fields found: nothing to do`);
      // @eslint-disable-next-line
      // @ts-ignore
      return; // skip to finally {}
    }

    const bufferView = new Uint8Array(buffer);

    requestedEdits.forEach(requestedEdit => {
      console.log('-----------------------------------');
      console.log(`Processing edit defn: tag=${requestedEdit.tag} msg=${requestedEdit.msgNum} fieldNum=${requestedEdit.fieldNum}`);
      const messageToEdit = messagesToEdit[requestedEdit.msgNum];
      if (messageToEdit.messageSize === null) {
        throw new FITMessageNotFound(requestedEdit.msgNum);
      }
      const fieldToEdit = messageToEdit.fieldsToEdit[requestedEdit.fieldNum];
      if (fieldToEdit.messageOffset === null) {
        throw new FITFieldNotFound(requestedEdit.msgNum, requestedEdit.fieldNum, requestedEdit.tag);
      }

      fieldToEdit.fileOffsets.forEach(offset => {
        // i don't like this; this function shouldn't be modifying the requested
        // edit class instances *and* returning similar data in a different form
        // via editedMessages/messagesToEdit
        //
        // pick a lane
        requestedEdit.numberOfInstances++;

        const val = bufferView[offset];
        console.log(`• Editing field at offset=${offset} value=${val}`);
        const editedVal = requestedEdit.editFn(val);
        if (editedVal !== val && editedVal !== null && editedVal !== undefined) {
          requestedEdit.numberOfEdits++; // i don't like this

          bufferView[offset] = editedVal;
          numberOfEdits++;
          fieldToEdit.numberOfEdits++;
          console.log(`value changed to ${editedVal}`);
        } else {
          console.log('value not changed');
        }
      })
      console.log('-----------------------------------');
    });

    console.log(`edited ${numberOfEdits} field instances`);

    const crc = CrcCalculator.calculateCRC(bufferView, 0, bufferView.length - 2);
    debugLog(`new CRC = ${crc}`);

    bufferView[bufferView.length - 2] = crc & 0xff;
    bufferView[bufferView.length - 1] = crc >> 8;

    {
      const decoder = new Decoder(new Stream(buffer));
      const isFIT = decoder.isFIT();
      const isCRCValid = decoder.checkIntegrity();
      console.log(`edited file is a FIT file: ${isFIT}`);
      console.log(`edited file's CRC is valid: ${isCRCValid}`);

      if (!isFIT) {
        throw new Error("failed to create valid FIT file");
      }
      if (!isCRCValid) {
        throw new Error("failed to calculate valid checksum");
      }

      const { errors } = decoder.read({
        includeUnknownData: true,
      });
      if (errors.length) {
        throw new FITDecoderError(errors, 'Edited FIT file is corrupt');
      }
    }
  } finally {
    // this is here to allow the try-blocks to exit early without duplicating the
    // return statement below
  }

  return {
    fitType,
    numberOfEdits,
    editedMessages: messagesToEdit,
  }
}

/**
 *
 * @param {ArrayBuffer} buffer a buffer containing the FIT file to be edited
 * @returns {number} number of alerts that were disabled
 */
function banishAlerts(buffer) {
  // message is not in profile
  const alertMsgNum = 16;

  // Field is not in profile
  // Type: 1 byte enum
  // Values: 1 = enabled, 0 = disabled, 255 = none/invalid
  const alertStatusField = 3;

  try {
    const {
      fitType,
      numberOfEdits,
    } = editFITFile(
      buffer,
      'sport',
      [
        new FITEditDefinition(
          alertMsgNum,
          alertStatusField,
          1,
          (val) => {
            if (val === 1) {
              console.log('alert is enabled');
              return 0;
            } else {
              console.log('alert is disabled');
              return null;
            }
          }
        )
      ]
    );

    // still too much duplicated code
    if (fitType !== 'sport') {
      throw new NotActivityProfileGenericError("Not an activity profile", fitType);
    }

    return numberOfEdits;
  } catch (e) {
    if (e instanceof FITMessageNotFound) {
      throw new NotActivityProfileError(`Could not find definition for alert message.`);
    }
    if (e instanceof FITFieldNotFound) {
      throw new NotActivityProfileError(`Could not find definition for alert status field.`);
    }
    throw e;
  }
}

/**
 * 
 * @param {ArrayBuffer} buffer the FIT file to edit
 * @returns {boolean} true if auto lap was disabled, false otherwise
 */
function disableLaps(buffer) {
  // message is in profile
  const trainingSettingsMsgNumber = 13;

  // Field is not in profile
  // Type: 1 byte enum
  // Values: 6 = manual laps only, 1 = auto lap by distance, ...
  const autoLapFieldNumber = 3;

  const autoLapDisabledValue = 6;

  try {
    const {
      fitType,
      numberOfEdits,
    } = editFITFile(
      buffer,
      'sport',
      [
        new FITEditDefinition(
          trainingSettingsMsgNumber,
          autoLapFieldNumber,
          1,
          (val) => {
            if (val !== autoLapDisabledValue) {
              console.log('auto lap is enabled');
              return autoLapDisabledValue;
            } else {
              console.log('auto lap is disabled');
              return null;
            }
          }
        )
      ]
    );

    if (fitType !== 'sport') {
      throw new NotActivityProfileGenericError("Not an activity profile", fitType);
    }

    return numberOfEdits > 0;
  } catch (e) {
    if (e instanceof FITMessageNotFound) {
      throw new NotActivityProfileError(`Could not find definition for training settings message.`);
    }
    if (e instanceof FITFieldNotFound) {
      throw new NotActivityProfileError(`Could not find definition for auto lap field.`);
    }
    throw e;
  }
}

function onFileInputChange() {
  onFileInputChangeImpl(this)
    .catch((e) => {
      console.error(e);
      showResult('.result_error', e);
    })
}

async function onFileInputChangeImpl(input) {
  const file = input.files[0];
  if (file) {
    // input.value = null;

    document.querySelectorAll(".selectedFile").forEach(el => {
      el.innerText = file.name;
      el.classList.remove("hidden");
    });
    document.querySelectorAll(".upload-container").forEach(el => {
      el.classList.add("input-group");
    });

    console.log('----------------------------------------------------------------------');
    console.log(`Reading ${file.name}...`)
    const buffer = await file.arrayBuffer();

    // const noGhosts = document.querySelector('.no-ghosts')
    const noLaps = document.querySelector('.no-laps')

    const lapMode = (noLaps && noLaps.classList.contains('show'));
    if (lapMode) {
      console.log('Preparing to remove ghost laps from FIT file...')
    } else {
      console.log('Preparing to remove ghost alerts from FIT file...')
    }

    try {
      if (lapMode) {
        const turnedOffLaps = disableLaps(buffer);
        console.log(turnedOffLaps ? 'auto laps were disabled' : 'auto laps were not disabled');
        if (!turnedOffLaps) {
          showResult('.result-laps-none');
          return;
        }

        document.querySelectorAll(".count").forEach(el =>
          el.innerText = `⚠️ Turned off auto laps in the selected profile`
        );

      } else {
        const numBanishedAlerts = banishAlerts(buffer);
        console.log(`disabled ${numBanishedAlerts} alerts`);

        if (!numBanishedAlerts) {
          showResult('.result-none');
          return;
        }
        const numAlertsStr = numBanishedAlerts === 1 ? '1 alert' : `${numBanishedAlerts} alerts`;
        document.querySelectorAll(".count").forEach(el =>
          el.innerText = `⚠️ Disabled ${numAlertsStr} in the selected profile`
        );
      }
    } catch (e) {
      // TODO: clean up this mess
      if (e instanceof NotActivityProfileError) {
        showResult(lapMode ? '.result-laps-error-not-profile' : '.result-error-not-profile');
      } else if (e instanceof NotActivityProfileGenericError) {
        const fitTypeEl = document.querySelectorAll(".fit-type");
        fitTypeEl.forEach(el => el.innerText = e.fitType);
        showResult(lapMode ? '.result-laps-error-not-profile-generic' : '.result-error-not-profile-generic');
      } else {
        console.error(e);
        showResult('.result-error', e);
      }
      return;
    }

    const links = document.querySelectorAll(".download");
    links.forEach(link => {
      link.href = URL.createObjectURL(new Blob([buffer]));
      const basenameAndExt = getBasenameAndExt(file.name);
      const newName = basenameAndExt ?
        `${basenameAndExt[0]}-fixed${basenameAndExt[1]}` :
        file.name;
      link.innerText = newName;
      link.download = newName;
    })
    showResult('.result-success');
  }
}

/**
 * 
 * @param {string} selector 
 * @param {string} innerText 
 */
function showResult(selector, innerText) {
    document.querySelectorAll(selector).forEach(el => {
      if (innerText) {
        el.querySelector('.alert').innerText = innerText;
      }
      el.classList.add('show');
    });
}

/**
 * @returns {void}
 */
function reset() {
  // result-error can have indefinitely long text
  // due to fitdecoder errors
  document.querySelector(".result-error").querySelector('.alert').innerText = '---';

  document.querySelectorAll(".result").forEach(el => {
    el.classList.remove('show');
  });
  document.querySelectorAll(".selectedFile").forEach(el => {
    el.classList.add("hidden");
  });
  document.querySelectorAll(".upload-container").forEach(el => {
    el.classList.remove("input-group");
  });
}

/**
 * @returns {void}
 */
function main() {
  reset();
  document.getElementById("cover").classList.add('show');

  document.querySelectorAll(".uploadButton, .selectedFile").forEach(el => {
    el.addEventListener('click', () => {
      // it's a deliberate design decision to reset all results and the
      // currently selected file when the user clicks to select another file.
      //
      // maybe it would be better to just leave everything unless
      // the user selects a different file
      //
      // I think there's arguments to be made either way
      reset();
      document.querySelectorAll(".selectedFile").forEach(el => {
        el.innerText = '';
      });
      document.getElementById("fileinput").value = '';

      document.getElementById("fileinput").click();
    });
  });
  document
    .getElementById("fileinput").addEventListener("change", onFileInputChange);

  document.querySelectorAll(".nav-hash").forEach(el =>
    el.addEventListener('click', () => {
      reset();
      // history.pushState({}, "", el.getAttribute("href"));
      history.replaceState({}, "", el.getAttribute("href"));

      const target = el.getAttribute('data-bs-target');
      const extraTargets = document.querySelectorAll(`${target}-extra`);
      const allExtraTargets = document.querySelectorAll(`.extra-target`);
      allExtraTargets.forEach(el =>  {
        el.classList.remove('show');
        el.classList.add('hidden');
      })
      extraTargets.forEach(el => {
        el.classList.add('show');
        el.classList.remove('hidden');
      })
    })
  )
}

main();