/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow strict
 * @format
 */

'use strict';

import type {HermesNode} from './HermesAST';
import type {ParserOptions} from './ParserOptions';

import HermesParserDeserializer from './HermesParserDeserializer';
import HermesParserWASMModule from './HermesParserWASM';

let HermesParserWASM;
let hermesParse;
let hermesParseResult_free;
let hermesParseResult_getError;
let hermesParseResult_getErrorLine;
let hermesParseResult_getErrorColumn;
let hermesParseResult_getProgramBuffer;
let hermesParseResult_getPositionBuffer;
let hermesParseResult_getPositionBufferSize;

/**
 * Init the WASM wrapper code generated by `emscripten` to preparse the
 * HermesParser WASM code.
 */
function initHermesParserWASM() {
  if (HermesParserWASM != null) {
    return;
  }

  HermesParserWASM = HermesParserWASMModule({
    /**
     * The emscripten version of `quit` unconditionally assigns the `status` to
     * `process.exitCode` which overrides any pre-existing code that has been
     * set, even if it is non zero. For our use case we never want an
     * `exitCode` to be set so this override removes that functionality.
     */
    quit(_status: number, toThrow: Error) {
      throw toThrow;
    },
  });

  hermesParse = HermesParserWASM.cwrap('hermesParse', 'number', [
    'number',
    'number',
    'number',
    'number',
    'number',
    'number',
    'number',
  ]);

  hermesParseResult_free = HermesParserWASM.cwrap(
    'hermesParseResult_free',
    'void',
    ['number'],
  );

  hermesParseResult_getError = HermesParserWASM.cwrap(
    'hermesParseResult_getError',
    'string',
    ['number'],
  );

  hermesParseResult_getErrorLine = HermesParserWASM.cwrap(
    'hermesParseResult_getErrorLine',
    'number',
    ['number'],
  );

  hermesParseResult_getErrorColumn = HermesParserWASM.cwrap(
    'hermesParseResult_getErrorColumn',
    'number',
    ['number'],
  );

  hermesParseResult_getProgramBuffer = HermesParserWASM.cwrap(
    'hermesParseResult_getProgramBuffer',
    'number',
    ['number'],
  );

  hermesParseResult_getPositionBuffer = HermesParserWASM.cwrap(
    'hermesParseResult_getPositionBuffer',
    'number',
    ['number'],
  );

  hermesParseResult_getPositionBufferSize = HermesParserWASM.cwrap(
    'hermesParseResult_getPositionBufferSize',
    'number',
    ['number'],
  );
}

// Copy a string into the WASM heap and null-terminate
function copyToHeap(buffer: Buffer, addr: number) {
  HermesParserWASM.HEAP8.set(buffer, addr);
  HermesParserWASM.HEAP8[addr + buffer.length] = 0;
}

export function parse(source: string, options: ParserOptions): HermesNode {
  initHermesParserWASM();

  // Allocate space on heap for source text
  const sourceBuffer = Buffer.from(source, 'utf8');
  const sourceAddr = HermesParserWASM._malloc(sourceBuffer.length + 1);
  if (!sourceAddr) {
    throw new Error('Parser out of memory');
  }

  try {
    // Copy source text onto WASM heap
    copyToHeap(sourceBuffer, sourceAddr);

    const parseResult = hermesParse(
      sourceAddr,
      sourceBuffer.length + 1,
      options.flow === 'detect',
      options.enableExperimentalComponentSyntax,
      options.enableExperimentalFlowMatchSyntax,
      options.tokens,
      options.allowReturnOutsideFunction,
    );

    try {
      // Extract and throw error from parse result if parsing failed
      const err = hermesParseResult_getError(parseResult);
      if (err) {
        const syntaxError = new SyntaxError(err);
        // $FlowExpectedError[prop-missing]
        syntaxError.loc = {
          line: hermesParseResult_getErrorLine(parseResult),
          column: hermesParseResult_getErrorColumn(parseResult),
        };

        throw syntaxError;
      }

      const deserializer = new HermesParserDeserializer(
        hermesParseResult_getProgramBuffer(parseResult),
        hermesParseResult_getPositionBuffer(parseResult),
        hermesParseResult_getPositionBufferSize(parseResult),
        HermesParserWASM,
        options,
      );
      return deserializer.deserialize();
    } finally {
      hermesParseResult_free(parseResult);
    }
  } finally {
    HermesParserWASM._free(sourceAddr);
  }
}
