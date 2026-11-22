#version 450

layout(set = 0, binding = 0, std140) uniform UBO
{
   mat4 MVP;
   vec4 SourceSize;
   float Brightness;
};

#include "brightness.inc"

#pragma name BasicExample
#pragma format R8G8B8A8_UNORM
#pragma parameter Brightness "Brightness" 1.0 0.0 2.0 0.05

#pragma stage vertex
layout(location = 0) in vec4 Position;
layout(location = 1) in vec2 TexCoord;
layout(location = 0) out vec2 vTexCoord;
void main()
{
   gl_Position = MVP * Position;
   vTexCoord = TexCoord;
}

#pragma stage fragment
layout(location = 0) in vec2 vTexCoord;
layout(location = 0) out vec4 FragColor;
layout(binding = 1) uniform sampler2D Source;
void main()
{
   FragColor = applyBrightness(texture(Source, vTexCoord), Brightness);
}
