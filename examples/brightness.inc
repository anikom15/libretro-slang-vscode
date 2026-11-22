// Scale the sampled color by the configured brightness.
vec4 applyBrightness(vec4 color, float brightness)
{
   return color * brightness;
}
