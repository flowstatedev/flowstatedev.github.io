import { Decoder, MesgDefinition, Stream, CrcCalculator } from "@garmin/fitsdk";

// this solution pops up everywhere although I'm sure my adaptation of it
// is missing a few edge cases that don't matter like "" and "."
//
// (actually some variants are bad bc they return the basename and extension
// *without* the dot separator (like ['basename', 'ext'], which is def a problem
// if the caller actually needs to build a new filename based on the basename and
// ext, because they'll have to selectively add the dot for the case when the extension
// is not empty (e.g. ['basename', ''] and ['basename', ''] will require different handling
// by the caller, but the whole point of a utility function is avoid that kind of thing
//
// that's prolly why node.js's pathname.extname() function returns
// the extension *with* the dot separator.
// https://nodejs.org/api/path.html#pathextnamepath
//
// ofc my variant ain't all that, either
/**
 *
 * https://stackoverflow.com/questions/190852/how-can-i-get-file-extensions-with-javascript
 * https://alphons.io/question/173/how-to-split-name-and-extension-in-file-name-in-javascript
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
 * https://stackoverflow.com/a/901144
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
   * @param {string} message error message
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

// TODO: clean this up
/**
 * thrown when the given file is a fit file, but not an activity profile,
 * due to the absence of a certain message
 */
class NotActivityProfileError extends CustomError {
  /**
   * 
   * @param {string} message error message
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
   * @param {string} message error message
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

/**
 * thrown when the given file is a fit file, but not an activity profile,
 * due to the wrong FIT file type (i.e. not 'sport')
 */
class NotActivityError extends CustomError {
  /**
   * 
   * @param {string} message error message
   * @param {string} fitType e.g. 'sport'
   */
  constructor(message, fitType) {
    super(message);
    // this.name = this.constructor.name;
    this.name = 'NotActivityError';
    /** @type {string} */
    this.fitType = fitType;
  }
}

class FITDecoderError extends CustomError {
  /**
   * 
   * @param {Error[]} errors errors array from garmin FITDecoder
   * @param {string} [message] optional custom error message
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
    /** @type {Error[]} */
    this.errors = errors
  }
}

class FITMessageNotFound extends CustomError {
  /**
   * 
   * @param {number} messageNumber FIT global message number
   * @param {string} [tag] the tag from the corresponding FITEditDefinition
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
   * @param {number} messageNumber FIT global message number
   * @param {number} fieldNumber FIT field number
   * @param {string} [tag] the tag from the corresponding FITEditDefinition
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
     *  0-based offset from the beginning of the message data, not including the 1-byte header
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
   * @param {number} globalMsgNum FIT global message number
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
 * @returns {boolean} true if debug logs should be printed, false otherwise
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
 * @returns {{ fitType: string; numberOfEdits: number; editedMessages: { [key: number]: MessageInfo; }}} information
 * about the results of editing (additionally, properties on the existing elements of requestedEdits are modified)
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

  requestedEdits.forEach(requestedEdit => {
    const messageToEdit = messagesToEdit[requestedEdit.msgNum] || new MessageInfo(requestedEdit.msgNum);
    messageToEdit.fieldsToEdit[requestedEdit.fieldNum] =
      messageToEdit.fieldsToEdit[requestedEdit.fieldNum] || new FieldInfo(requestedEdit.fieldNum);
    messagesToEdit[requestedEdit.msgNum] = messageToEdit;
  });

  const onMesgDefinition = (/** @type {MesgDefinition} */ mesgDefinition) => {
    messageDefinitions.push(mesgDefinition);

    const messageToEdit = messagesToEdit[mesgDefinition.globalMessageNumber];
    if (messageToEdit) {
      console.log(`• Found message definition ${mesgDefinition.globalMessageNumber}`);
      debugLog(mesgDefinition);

      messageToEdit.messageSize = mesgDefinition.messageSize;

      /**
       * 0-based offset of the current field from the beginning of the
       * message data (not-including the 1-byte header)
       */
      let offset = 0;
      for (const def of mesgDefinition.fieldDefinitions) {
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
          // this means that the index could change, in the perhaps
          // unlikely event that the message is added to the profile in
          // te future
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
          //
          // no matter what happens, we have to rely on the garmin sdk to not
          // change its current behavior
          fieldToEdit.fieldID = def.name || def.fieldDefinitionNumber;

          console.log(`field ${def.fieldDefinitionNumber}: offset = ${fieldToEdit.messageOffset}, id = ${fieldToEdit.fieldID}`);
        }
        offset += def.size;
      }
    }
  }

  let numFieldInstances = 0;
  const onMesg = (/** @type {number} */ messageNumber, /** @type {object} */ message) => {
    const messageToEdit = messagesToEdit[messageNumber];
    if (messageToEdit) {
      console.log(`• Found message ${messageNumber}`);
      debugLog(message);

      if (messageToEdit.messageSize === null) {
        // caught by Garmin
        throw new Error(`found message ${messageNumber} data before message definition`);
      }

      messageToEdit.numberOfInstances++;

      for (const fieldNum in messageToEdit.fieldsToEdit) {
        const fieldToEdit = /** @type {FieldInfo} */ (messageToEdit.fieldsToEdit[fieldNum]);
        if (fieldToEdit.messageOffset === null) {
          // caught by Garmin
          throw new Error(`found message ${messageNumber} field ${fieldNum} data without field definition`);
        }

        // • the stream is positioned right after the current message.
        // • stream.position - messageToEdit.messageSize is the start of the message data
        // (not including the 1 byte header)
        //
        // another (naive) approach is to try to remember the position
        // of the stream prior to this message, and add 1 (for the msg header) plus the field offset to that value.
        // that works in some cases (like alerts), but not others (like training settings),
        // for reasons that aren't 100% clear yet. In the latter case, the offsets were
        // exactly 255 bytes too small (which is the exactly the same size as the msg definition
        // for the training settings, which immediately preceded the msg data.)
        const offsetToUse = stream.position - messageToEdit.messageSize + fieldToEdit.messageOffset;

        fieldToEdit.fileOffsets.push(offsetToUse);
        numFieldInstances++;
        console.log(`Found field ${fieldNum} at file offset ${offsetToUse}`);
      }
    }
  };

  /** @type {{messages: object[], errors: Error[]}} */ 
  const {
    messages,
    errors
  } = decoder.read({
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
  } catch (/** @type {any} */ e) {
    throw new Error(`could not determine FIT file type: ${e.message}`);
  }

  process_fit: {
    console.log(`FIT type = ${fitType}`)
    if (fitType !== expectedFileType) {
      break process_fit;
    }

    if (numFieldInstances === 0) {
      console.log(`no fields found: nothing to do`);
      // @eslint-disable-next-line
      // @ts-ignore
      break process_fit;
    }

    const bufferView = new Uint8Array(buffer);

    requestedEdits.forEach(requestedEdit => {
      console.log('-----------------------------------');
      console.log(`Processing edit defn: tag=${requestedEdit.tag} msg=${requestedEdit.msgNum} fieldNum=${requestedEdit.fieldNum}`);
      const messageToEdit = /** @type {MessageInfo} */ (messagesToEdit[requestedEdit.msgNum]);
      if (messageToEdit.messageSize === null) {
        throw new FITMessageNotFound(requestedEdit.msgNum);
      }
      const fieldToEdit = /** @type {FieldInfo} */ (messageToEdit.fieldsToEdit[requestedEdit.fieldNum]);
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

        if (offset >= buffer.byteLength - 2 || offset < 0) {
          throw new Error(`file offset is out of range: offset=${offset} file size=${buffer.byteLength}`);
        }

        const val = /** @type {number} */ (bufferView[offset]);
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

/**
 *
 * @param {ArrayBuffer} buffer a buffer containing the FIT file to be edited
 * @returns {number} number of alerts that were disabled
 */
function changePoolLengthUnitToMetric(buffer) {
  // Message in profile
  const sessionMsgNum = 18;

  // Field in profile
  // Type: 1 byte enum
  // Values: 0 = metric, 1 = statute, 2 = nautical
  const poolLengthUnitField = 46;

  try {
    const {
      fitType,
      numberOfEdits,
    } = editFITFile(
      buffer,
      'activity',
      [
        new FITEditDefinition(
          sessionMsgNum,
          poolLengthUnitField,
          1,
          (val) => {
            if (val === 0) {
              console.log('pool length unit is already metric; doing nothing');
              return null;
            } else if (val === 1) {
              console.log('pool length unit is statute, changing to metric');
              return 0;
            } else if (val === 2) {
              console.warn('pool length unit is nautical (2) (???), changing to metric');
              return 0;
            } else {
              console.warn(`pool length unit is invalid ${val}, changing to metric`);
              return 0;
            }
          }
        )
      ]
    );

    // still too much duplicated code
    if (fitType !== 'activity') {
      throw new NotActivityError("Not an activity profile", fitType);
    }

    return numberOfEdits;
  } catch (e) {
    if (e instanceof FITMessageNotFound) {
      throw new CustomError(`Could not find definition for session message. Is this an activity FIT file?`);
    }
    if (e instanceof FITFieldNotFound) {
      throw new CustomError(`Could not find definition for pool length field. Is this a pool swim activity FIT file?`);
    }
    throw e;
  }
}

/**
 *
 * @param {ArrayBuffer} buffer a buffer containing the FIT file to be edited
 * @param {number|null} editVal
 * @returns {number|null} current setting
 */
function readOrEditAutoLockSetting(buffer, editVal) {
  // Device Setting message - defined in profile
  const deviceSettingsMsgNum = 2;

  // Auto-Lock field - not in profile (reverse engineered from FR955)
  // Type: 1 byte enum
  /* Values:
    0 - off
    1 - always
    2 - during activity
    3 - not during activity
  */
  const autolockSettingField = 135;

  let fieldVal = null
  try {
    const {
      fitType,
      // numberOfEdits,
    } = editFITFile(
      buffer,
      'settings',
      [
        new FITEditDefinition(
          deviceSettingsMsgNum,
          autolockSettingField,
          1,
          (val) => {
            if (editVal !== null) {
              if (val !== editVal) {
                fieldVal = editVal
                console.log(`Changing auto-lock setting to ${editVal}`)
                return editVal;
              }
            }

            fieldVal = val
            return null
          }
        )
      ]
    );

    // still too much duplicated code
    if (fitType !== 'settings') {
      throw new CustomError(`This is not a settings FIT file, it's a FIT file with type '${fitType}'`);
    }

    if (fieldVal === null) {
      throw new CustomError(`Could not find auto-lock field in FIT file`);
    }

    if (fieldVal !== null) {
      if (typeof fieldVal !== 'number' || (fieldVal < 0 || fieldVal > 3)) {
        throw new CustomError(`Unknown auto-lock value: '${fieldVal}'`);
      }
    }

    return fieldVal;
  } catch (e) {
    if (e instanceof FITMessageNotFound) {
      throw new CustomError(`Could not find definition for device settings message. Is this a settings FIT file?`);
    }
    if (e instanceof FITFieldNotFound) {
      throw new CustomError(`Could not find definition for auto-lock setting field`);
    }
    throw e;
  }
}



// ====================================================================================

// clearly a lot of the code below is fragile asf because certain
// change in the markup can cause a crash.
// luckily this isn't a real project.
// the type hints purposely leave the types as nullable (e.g. HTMLInputElement?)
// so that "Object is possibly 'null'." errors stick around.

// also, the type hints serve to document some of the assumptions made
// about certain elements on the page

// maybe next time just use react mmmmmmmmmkay

/**
 * onchange handler for input element  which receives a FIT file to be fixed.
 * just a wrapper around the async function that actually does the work
 * @this {HTMLInputElement}
 */
function onFileInputChange() {
  onFileInputChangeImpl(this)
    .catch((e) => {
      console.error(e);
      showResult('.result_error', e);
    })
}

/**
 * @this {HTMLInputElement}
 */
function onAutolockRadioChange() {
  // console.log(this.value)
  const applySelector = this.getAttribute("data-apply")
  console.log(applySelector)
  if (applySelector) {
    const applyBtn = document.querySelector(applySelector)
    // console.log(applyBtn)
    if (applyBtn) {
      applyBtn.removeAttribute("disabled")
      applyBtn.classList.remove("disabled")
    }
    document.querySelectorAll(".autolock-finish").forEach((el) => {
      el.classList.remove("show");
      el.classList.add("hidden");
    })
  }
}

/** @type {ArrayBuffer|undefined} */
let settingsFileBuffer
/** @type {string|undefined} */
let settingsFilename
/**
 * @this {HTMLButtonElement}
 */
function onAutolockApply() {
  const tabname = this.getAttribute("data-tabname");
  if (tabname) {
    /** @type {HTMLInputElement|null} */
    const radioInput = document.querySelector(`.autolock-${tabname} input[name='autolockRadio']:checked`)
    if (radioInput && settingsFileBuffer && settingsFilename) {
      // console.log(`radio value = ${radioInput.value}`)
      const editVal = radioInput.value
      console.log(`Preparing to change autolock setting in SETTINGS.FIT file to ${editVal}...`);
      const fieldVal = readOrEditAutoLockSetting(settingsFileBuffer, parseInt(editVal, 10))
      console.log(`new autolock val = ${fieldVal}`);

      /** @type {NodeListOf<HTMLAnchorElement>} */
      const links = document.querySelectorAll(".autolock-download");
      links.forEach(link => {
        if (settingsFileBuffer && settingsFilename) {
          link.href = URL.createObjectURL(new Blob([settingsFileBuffer]));
          const basenameAndExt = getBasenameAndExt(settingsFilename);
          const newName = basenameAndExt ?
            `${basenameAndExt[0]}-modified${basenameAndExt[1]}` :
            settingsFilename;
          link.innerText = newName;
          link.download = newName;
        }
      });

      document.querySelectorAll(".autolock-finish").forEach((el) => {
        el.classList.remove("hidden");
        el.classList.add("show");
      });
    }
  }
  settingsFileBuffer = undefined
  settingsFilename = undefined
}

/**
 * 
 * @param {HTMLInputElement} input input element which receives a FIT file to be fixed
 * @returns {Promise<void>}
 */
async function onFileInputChangeImpl(input) {
  if (!input.files) return;
  const file = input.files[0];
  if (file) {
    // input.value = null;

    /** @type {NodeListOf<HTMLSpanElement>} */
    (document.querySelectorAll(".selectedFile")).forEach(el => {
      el.innerText = file.name;
      el.classList.remove("hidden");
    });
    document.querySelectorAll(".upload-container").forEach(el => {
      el.classList.add("input-group");
    });

    console.log('----------------------------------------------------------------------');
    console.log(`Reading ${file.name}...`)
    const buffer = await file.arrayBuffer();

    const actions = {
      'noGhosts': document.querySelector('.no-ghosts'),
      'noLaps': document.querySelector('.no-laps'),
      'metricPool': document.querySelector('.metric-pool'),
      'autolock': document.querySelector('.autolock'),
    };

    let selectedAction = "noGhosts";
    for (const action in actions) {
      const actionElement = actions[action];
      if (actionElement && actionElement.classList.contains('show')) {
        selectedAction = action;
        break;
      }
    }

    try {
      switch (selectedAction) {
        case 'noGhosts': {
          console.log('Preparing to remove ghost alerts from FIT file...')
          const numBanishedAlerts = banishAlerts(buffer);
          console.log(`disabled ${numBanishedAlerts} alerts`);

          if (!numBanishedAlerts) {
            showResult('.result-none');
            return;
          }
          const numAlertsStr = numBanishedAlerts === 1 ? '1 alert' : `${numBanishedAlerts} alerts`;
          /** @type {NodeListOf<HTMLSpanElement>} */
          (document.querySelectorAll(".count")).forEach(el =>
            el.innerText = `⚠️ Disabled ${numAlertsStr} in the selected profile`
          );

          break;
        }
        case 'noLaps': {
          console.log('Preparing to remove ghost laps from FIT file...')
          const turnedOffLaps = disableLaps(buffer);
          console.log(turnedOffLaps ? 'auto laps were disabled' : 'auto laps were not disabled');
          if (!turnedOffLaps) {
            showResult('.result-laps-none');
            return;
          }

          /** @type {NodeListOf<HTMLSpanElement>} */
          (document.querySelectorAll(".count")).forEach(el =>
            el.innerText = `⚠️ Turned off auto laps in the selected profile`
          );
          break;
        }
        case 'metricPool': {
          console.log('Preparing to change pool length unit to metric, in FIT file...')
          const numEdits = changePoolLengthUnitToMetric(buffer)
          console.log(numEdits ? 'pool length units were changed' : 'pool length units were not changed');
          if (numEdits === 0) {
            showResult('.result-pool-none');
            return;
          }

          /** @type {NodeListOf<HTMLSpanElement>} */
          (document.querySelectorAll(".count")).forEach(el =>
            el.innerText = `⚠️ Changed pool length units to metric, in the selected activity`
          );
          break;
        }
        case 'autolock': {
          console.log('Preparing to read autolock setting from SETTINGS.FIT file...')
          const fieldVal = readOrEditAutoLockSetting(buffer, null)
          settingsFileBuffer = buffer
          settingsFilename = file.name
          console.log(`autolock value = ${fieldVal}`)

          let fieldStr = "";
          switch (fieldVal) {
            case 0:
              fieldStr = "Off"
              break;
            case 1:
              fieldStr = "Always"
              break;
            case 2:
              fieldStr = "During Activity"
              break;
            case 3:
              fieldStr = "Not During Activity"
              break;
            case 4:
              fieldStr = "Unknown"
              break;
          }

          /** @type {NodeListOf<HTMLSpanElement>} */
          (document.querySelectorAll(".count")).forEach(el =>
            // el.innerText = `Current Auto-Lock setting: ${fieldStr} (${fieldVal})`
            el.innerText = `Current Auto-Lock setting: ${fieldStr}`
          );

          /** @type {NodeListOf<HTMLInputElement>} */
          (document.querySelectorAll(".autolockRadio")).forEach(el => {
            el.removeAttribute("disabled")
            el.checked = false
            el.addEventListener('click', onAutolockRadioChange)
          });
          (document.querySelectorAll(`.autolockRadio${fieldVal}`)).forEach(el =>
            el.setAttribute("disabled", "disabled")
          );
          (document.querySelectorAll(".autolockApply")).forEach(el => {
            el.setAttribute("disabled", "disabled")
            el.addEventListener('click', onAutolockApply)
          });
          document.querySelectorAll(".autolock-finish").forEach((el) => {
            el.classList.remove("show");
            el.classList.add("hidden");
          })
          showResult('.result-success');
          return;
        }
      }
    } catch (/** @type {any} */ e) {
      // TODO: clean up this mess
      if (e instanceof NotActivityProfileError) {
        showResult(selectedAction === 'noLaps' ? '.result-laps-error-not-profile' : '.result-error-not-profile');
      } else if (e instanceof NotActivityError) {
        /** @type {NodeListOf<HTMLSpanElement>} */
        const fitTypeEl = document.querySelectorAll(".fit-type");
        fitTypeEl.forEach(el => el.innerText = e.fitType);
        showResult('.result-error-not-activity');
      } else if (e instanceof NotActivityProfileGenericError) {
        /** @type {NodeListOf<HTMLSpanElement>} */
        const fitTypeEl = document.querySelectorAll(".fit-type");
        fitTypeEl.forEach(el => el.innerText = e.fitType);
        showResult(selectedAction === 'noLaps' ? '.result-laps-error-not-profile-generic' : '.result-error-not-profile-generic');
      } else {
        console.error(e);
        showResult('.result-error', e);
      }
      return;
    }

    /** @type {NodeListOf<HTMLAnchorElement>} */
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
 * @param {string} selector query selector for an element that displays result info to the user
 * @param {string} [innerText] optional text to set on the ".alert" child of the result element
 */
function showResult(selector, innerText) {
    document.querySelectorAll(selector).forEach(el => {
      if (innerText) {
        /** @type {HTMLDivElement?} */
        (el.querySelector('.alert'))
          .innerText = innerText;
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
  /** @type {HTMLDivElement?} */
  (document.querySelector(".result-error").querySelector('.alert')).innerText = '---';

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
      /** @type {NodeListOf<HTMLSpanElement>} */
      (document.querySelectorAll(".selectedFile")).forEach(el => {
        el.innerText = '';
      });

      const fileinput = /** @type {HTMLInputElement?} */ (document.getElementById("fileinput"));
      fileinput.value = '';
      fileinput.click();
    });
  });
  document.getElementById("fileinput").addEventListener("change", onFileInputChange);

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