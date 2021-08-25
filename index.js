/* eslint-env node */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import findCacheDir from 'find-cache-dir';
import {bundleWat} from './lib/bundle-wat.js';
// import {collectWasmImports} from './lib/collect-wasm-imports.js';

export {watPlugin as default};

let wabt;
let cacheDir = findCacheDir({name: 'eslint-plugin-wat', create: true});

// TODO: watchFiles
// TODO: integrate wrap-wasm
function watPlugin({
  inlineFunctions = false,
  bundle = false, // bundle wasm files together based on custom import syntax
  wrap = false, // not implemented -- import functions directly with import statement
  treeshakeWasmImports = false, // not implemented -- strip away unused wasm when using wrap
  ignoreCache = false,
  loader = 'binary',
  wasmFeatures = {},
} = {}) {
  wasmFeatures = {
    ...defaultWasmFeatures,
    ...wasmFeatures,
  };

  return {
    name: 'esbuild-plugin-wat',
    async setup(build) {
      if (wrap && treeshakeWasmImports) {
        // TODO: collect all wasm imports to know what to tree-shake
        // let wasmImports = collectWasmImports(build.initialOptions.entryPoints);
      }

      build.onLoad(
        {filter: /.wat$/},
        async ({path: watPath}) => {
          let watBytes = await fs.promises.readFile(watPath);
          let wasmBytes = await fromCache(watPath, watBytes, async watBytes => {
            if (wabt === undefined) {
              let createWabt = (await import('wabt')).default;
              wabt = await createWabt();
            }
            let bytes;
            if (bundle) {
              let {wasm, exportNames} = await bundleWat(wabt, watPath);
              // TODO: use exportNames to expose info to wasm wrapper
              bytes = wasm;
            } else {
              let wabtModule = wabt.parseWat(watPath, watBytes, wasmFeatures);
              bytes = new Uint8Array(wabtModule.toBinary({}).buffer);
            }
            if (inlineFunctions) {
              bytes = transformInlineFunctions(bytes);
            }
            return bytes;
          });
          return {
            contents: wasmBytes,
            loader,
          };
        },
        ignoreCache
      );

      build.onLoad({filter: /.wasm$/}, async ({path: wasmPath}) => {
        let wasmBytes = await fs.promises.readFile(wasmPath);
        wasmBytes = await fromCache(
          wasmPath,
          wasmBytes,
          async bytes => {
            if (bundle) {
              if (wabt === undefined) {
                wabt = await (await import('wabt')).default();
              }
              let {wasm, exportNames} = await bundleWat(wabt, wasmPath);
              bytes = wasm;
            }
            if (inlineFunctions) {
              bytes = transformInlineFunctions(bytes);
            }
            return bytes;
          },
          ignoreCache
        );
        return {
          contents: wasmBytes,
          loader,
        };
      });
    },
  };
}

const defaultWasmFeatures = {
  exceptions: true,
  mutable_globals: true,
  sat_float_to_int: true,
  sign_extension: true,
  simd: true,
  threads: true,
  multi_value: true,
  tail_call: true,
  bulk_memory: true,
  reference_types: true,
  annotations: true,
  gc: true,
};

let binaryen;
async function transformInlineFunctions(wasmBytes) {
  if (binaryen === undefined) {
    // this import takes forever which is why we make it optional
    binaryen = (await import('binaryen')).default;
  }
  let module = binaryen.readBinary(wasmBytes);

  binaryen.setOptimizeLevel(3);
  binaryen.setShrinkLevel(0);
  binaryen.setFlexibleInlineMaxSize(1000000000);
  module.runPasses(['inlining-optimizing']);
  // module.optimize();

  return module.emitBinary();
}

function hash(stuff) {
  return crypto.createHash('sha1').update(stuff).digest('base64url');
}

//  memoize bytes-to-bytes transform
async function fromCache(key, content, transform, ignoreCache) {
  let keyHash = hash(key);
  let contentHash = hash(content);
  let result;

  try {
    result = await fs.promises.readFile(
      path.resolve(cacheDir, `${keyHash}.${contentHash}.wasm`)
    );
  } catch {}

  if (result === undefined || ignoreCache) {
    result = await transform(content);
    // clean old cached files, then write new one
    fs.promises
      .readdir(cacheDir)
      .then(files =>
        Promise.all(
          files
            .filter(f => f.startsWith(keyHash))
            .map(f => fs.promises.unlink(path.resolve(cacheDir, f)))
        )
      )
      .then(() => {
        fs.promises.writeFile(
          path.resolve(cacheDir, `${keyHash}.${contentHash}.wasm`),
          result
        );
      });
  }
  return result;
}
