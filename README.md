# Libretro Slang

VS Code language support for Libretro `.slang` shaders and `.slangp` presets.

## Features

- Syntax highlighting for pragmas, known formats, layout qualifiers, literals, GLSL built-in functions and types, built-in semantics, and preset keys
- Semantic highlighting for recognized function parameters, struct types, shader parameters, aliases, functions, and variables
- Document links for `#include`, `#pragma include`, `#pragma include_optional`, shader paths, and preset texture paths
- Warnings for a missing `#version`, vertex stage, or fragment stage in `.slang` files
- `.inc` files may omit stages but must not contain a `#version` directive
- Parameter declaration and duplicate declaration diagnostics within an expanded shader
- Nested include and framebuffer-format diagnostics, including missing files and include cycles
- Parameter hover and Go to Definition across included files
- Hover documentation from contiguous comments above a definition or an inline comment after it
- Go to Definition for recognized functions, uniform-block members, and stage interface declarations
- Warnings for recognized uniform type mismatches and vertex/fragment interface type mismatches at matching locations
- Compiler-backed GLSL diagnostics, built-in function hover, and signature help
- Warnings for missing parameter steps and apparent missing stage output assignments or matching interfaces
- Document outlines for shader stages and parameters
- Completion suggestions for pragmas, built-in uniforms, and preset keys

Preset shader counts may be quoted or unquoted. Links are provided for shader
paths and for texture paths whose keys are listed in `textures`, not for other
quoted preset values.

## Supported files

- `.slang`
- `.inc` (treated as Libretro Slang)
- `.slangp`

## Test locally

1. Open this folder in VS Code.
2. Press **F5** and select **Run Libretro Slang Extension** if prompted. VS Code opens an Extension Development Host with this extension enabled.
3. In that window, open [`examples/basic.slang`](./examples/basic.slang) or [`examples/basic.slangp`](./examples/basic.slangp). Try changing a stage pragma or include path to see diagnostics and navigation.

Run the extension's tests from a terminal in this folder with `npm test`.

## GLSL compiler

Install `glslangValidator` and make it available on PATH, or set
`libretro-slang.glslangValidatorPath` to its executable in user settings. Standalone
`.slang` files are checked with Vulkan GLSL semantics after includes are expanded;
hover and signature help for built-in calls come from the same compiler. Hover ranks
and narrows overloads using argument count and types when these can be inferred from
simple expressions and resolved declarations, including declarations from includes.
Unknown types and possible numeric conversions remain candidates; this is not full GLSL
overload resolution. If no candidates match, hover shows all overloads instead. Hover
shows up to 12 candidates; signature help lists them all. For include files and shared code
without a stage, the fragment stage is used; files without `#version` use GLSL 450
for this help. A warning reports when
the compiler is unavailable. Set `libretro-slang.validateGlsl` to `false` to disable
compiler diagnostics. `libretro-slang.validateStructure` disables all shader diagnostics.
Edits revalidate the changed shader and open shaders that depend on the changed
include; configuration changes revalidate all open shaders.
Set the `GLSLANG_TEST_PATH` environment variable to the compiler executable when running
`npm test` to include compiler integration tests.

The Slang specification permits omitting the parameter step; this extension warns when
it is omitted and reports nonnumeric parameter values as errors.

The include model follows nested includes in source order, including directives inside
preprocessor conditionals, and uses unsaved editor contents when available. Diagnostics
from an included file are shown on the including line in the open shader. Parameter
resolution covers the current file and its includes, not shaders that include the current
file or other passes in a preset.

Semantic analysis recognizes common global and local declarations, function parameters,
struct names, uniform-block members, and function declarations and definitions.
Function navigation filters by argument count
and, for obvious literal or constructor arguments, exact types; ambiguous overloads
return multiple locations. Interface declarations link by explicit location, not name.
This is not a full GLSL compiler: complex local declarations (such as loop initializers),
macro expansion, interface blocks, composite location allocation, and preset-provided
aliases are not fully resolved.
Conditional declarations are excluded from semantic mismatch warnings.
Stage output warnings look for assignments anywhere in the expanded stage, including
helper functions; they do not prove that assignments execute on every path. These
checks are skipped when includes cannot be resolved or preprocessor conditions or
macros make the result uncertain. Fragment inputs are compared by explicit location
for simple scalar and vector declarations; interface blocks, arrays, and composite
location allocation are not fully checked. GLSL compiler diagnostics are separate
from these conservative Slang-specific checks.
Semantic colors depend on the active theme and the `editor.semanticHighlighting.enabled`
setting. Alias highlighting covers names declared by `#pragma name` or `#pragma alias`
in the current shader and its includes.

Hover documentation uses adjacent `//` or `/* ... */` comments immediately above a
recognized declaration, plus a comment following its terminating `;` or opening `{` on
the same line. A blank line separates a comment from a declaration. Parameter pragmas
also show their adjacent and inline comments. Hover resolves these comments across includes.

Stage directives in an include are processed in expanded source order: they apply to
subsequent lines in the include and the including file until another stage directive.
Stages supplied by includes satisfy the standalone shader's stage checks.
