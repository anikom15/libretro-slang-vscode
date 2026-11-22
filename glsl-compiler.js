// Copyright (C) 2026  W. M. Martinez
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

"use strict";

const { spawn } = require("child_process");

/**
 * Run glslangValidator with source on stdin, collecting stdout and stderr together.
 * Compiler exit codes are returned to the caller; spawn, timeout and output-limit
 * failures reject. EPIPE is ignored because the compiler may exit before reading.
 * @param {string} executable Compiler executable or path.
 * @param {string[]} args Compiler arguments.
 * @param {string} source Source to write to stdin.
 * @returns {Promise<{code: number, output: string}>}
 */
function runCompiler(executable, args, source) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true });
    let output = "";
    let failure = null;
    const timeout = setTimeout(() => {
      failure = new Error("GLSL compiler timed out after 15 seconds.");
      child.kill();
    }, 15000);
    function collect(chunk) {
      output += chunk;
      if (output.length > 8 * 1024 * 1024 && !failure) {
        failure = new Error("GLSL compiler output exceeded 8 MiB.");
        child.kill();
      }
    }
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    child.stdin.on("error", error => {
      if (error.code !== "EPIPE") failure = error;
    });
    child.on("error", error => { failure = error; });
    child.on("close", code => {
      clearTimeout(timeout);
      if (failure) reject(failure);
      else if (code === null) reject(new Error("GLSL compiler terminated unexpectedly."));
      else resolve({ code, output });
    });
    child.stdin.end(source);
  });
}

/**
 * Select one stage of the expanded include model for compilation. Shared lines
 * appear in both stages, and stripped Slang pragmas leave blank lines so compiler
 * line numbers continue to index the returned entries.
 * @param {object} model Expanded include model.
 * @param {string} stage Shader stage to select.
 * @returns {{entries: object[], text: string}} Entries corresponding to source lines.
 */
function stageSource(model, stage) {
  const entries = model.entries.filter(entry => !entry.stage || entry.stage === stage);
  return {
    entries,
    text: entries.map(entry => /^\s*#\s*pragma\s+(?:stage|parameter|name|alias|format|include_optional)\b/.test(entry.text) ? "" : entry.text).join("\n") + "\n"
  };
}

/**
 * Compile each present stage and map compiler messages back to source entries.
 * Compilation is skipped if includes have errors; a failed compiler invocation
 * without a usable source diagnostic rejects rather than appearing successful.
 * @param {object} model Expanded include model.
 * @param {string} executable Compiler executable or path.
 * @returns {Promise<object[]>} Source entries augmented with severity and message.
 */
async function validateWithCompiler(model, executable) {
  if (model.issues.length) return [];
  const issues = [];
  for (const stage of ["vertex", "fragment"]) {
    if (!model.entries.some(entry => entry.stage === stage)) continue;
    const source = stageSource(model, stage);
    const result = await runCompiler(executable, [
      "--stdin", "-S", stage === "vertex" ? "vert" : "frag", "-V", "-o",
      process.platform === "win32" ? "NUL" : "/dev/null"
    ], source.text);
    let reported = false;
    for (const line of result.output.split(/\r?\n/)) {
      const match = line.match(/^(ERROR|WARNING): (?:stdin|0):(\d+):\s*(.+)$/);
      if (!match || /compilation terminated/i.test(match[3])) continue;
      const entry = source.entries[Number(match[2]) - 1];
      if (!entry) continue;
      reported = true;
      issues.push({ ...entry, severity: match[1] === "ERROR" ? "error" : "warning",
        message: `${stage} GLSL: ${match[3].trim()}` });
    }
    if (result.code !== 0 && !reported) {
      throw new Error(`GLSL compiler failed for ${stage}: ${result.output.trim() || `exit code ${result.code}`}`);
    }
  }
  return issues;
}

/**
 * Read compiler-provided built-in signatures for a stage and version.
 * Signatures retain glslangValidator's type descriptions, not GLSL syntax.
 * Rejects if the compiler fails or its output contains no recognizable signatures.
 * @param {string} executable Compiler executable or path.
 * @param {string} stage Shader stage; "vertex" selects vert, otherwise frag.
 * @param {string} version Complete GLSL version directive.
 * @returns {Promise<Map<string, string[]>>} Function names mapped to overloads.
 */
async function builtinSignatures(executable, stage, version) {
  const result = await runCompiler(executable, ["--stdin", "-S", stage === "vertex" ? "vert" : "frag",
    "--dump-builtin-symbols", "--no-link"], `${version}\nvoid main() {}\n`);
  if (result.code !== 0) throw new Error(`Could not load GLSL built-in signatures: ${result.output.trim()}`);
  const signatures = new Map();
  for (const line of result.output.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z_]\w*):\s+global\s+(.+)\s+\1\(\s*(.*?)\s*\)\s*$/);
    if (!match) continue;
    if (!signatures.has(match[1])) signatures.set(match[1], []);
    signatures.get(match[1]).push(`${match[2]} ${match[1]}(${match[3]})`);
  }
  if (!signatures.size) throw new Error("GLSL compiler did not provide built-in signatures.");
  return signatures;
}

/**
 * Narrow and rank compiler signatures using inferred call argument types.
 * Unknown types and unrecognized descriptors stay eligible; same-width numeric
 * types are conservatively treated as potential conversions. This is not full
 * GLSL overload resolution, including qualifier and conversion rules.
 * @param {string[]} signatures Compiler-provided overload descriptions.
 * @param {(string|null)[]|null} argumentTypes Null for an incomplete call; null
 * entries represent arguments whose types could not be inferred.
 * @returns {{overloads: string[], fallback: boolean}} All signatures are returned
 * with fallback set when no candidate matched.
 */
function rankBuiltinOverloads(signatures, argumentTypes) {
  const commonFirst = (a, b) => {
    const score = signature => (/\b(?:float16_t|f16sampler\w*|double|int64_t|uint64_t)\b/.test(signature) ? 1 : 0);
    return score(a) - score(b);
  };
  const all = [...signatures].sort(commonFirst);
  if (!argumentTypes) return { overloads: all, fallback: false };
  const ranked = [];
  for (const signature of all) {
    const match = signature.match(/\(([^()]*)\)\s*$/);
    if (!match) {
      ranked.push({ signature, score: 0 });
      continue;
    }
    const parts = match[1].trim() ? match[1].split(/\s*,\s*/) : [];
    if (parts.length !== argumentTypes.length) continue;
    let score = 0;
    let compatible = true;
    for (let i = 0; i < parts.length; i++) {
      if (!argumentTypes[i]) continue;
      const part = parts[i].replace(/^\s*(?:(?:const|in|out|inout|highp|mediump|lowp)\s+)*/, "").trim();
      const vector = /^([234])-component vector of (float16_t|float|double|int|uint|bool)(?:\s+\w+)?$/.exec(part);
      const scalar = /^(float|double|int|uint|bool|(?:[iu]|f16)?sampler\w+)(?:\s+\w+)?$/.exec(part);
      const prefixes = { float: "", double: "d", int: "i", uint: "u", bool: "b" };
      let expected = scalar && scalar[1];
      if (vector && Object.prototype.hasOwnProperty.call(prefixes, vector[2])) expected = `${prefixes[vector[2]]}vec${vector[1]}`;
      if (!expected) continue;
      if (argumentTypes[i] === expected) score += 2;
      else {
        const numeric = /^(?:float|double|int|uint|[iud]?vec[234])$/;
        const comparable = /^(?:bool|bvec[234]|float|double|int|uint|[iud]?vec[234]|(?:[iu]|f16)?sampler\w+)$/;
        if (!comparable.test(argumentTypes[i])) continue;
        const width = type => type.match(/[234]$/)?.[0] || "1";
        if (numeric.test(argumentTypes[i]) && numeric.test(expected) &&
            width(argumentTypes[i]) === width(expected)) score++;
        else compatible = false;
      }
    }
    if (compatible) ranked.push({ signature, score });
  }
  if (!ranked.length) return { overloads: all, fallback: true };
  return { overloads: ranked.sort((a, b) => b.score - a.score).map(item => item.signature), fallback: false };
}

module.exports = { stageSource, validateWithCompiler, builtinSignatures, rankBuiltinOverloads };
