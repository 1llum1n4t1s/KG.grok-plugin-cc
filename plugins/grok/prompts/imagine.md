Generate the image the user asked for with Grok Build's built-in image tool.

<request>
{{USER_REQUEST}}
</request>

{{ASPECT_INSTRUCTION}}

Use `image_gen` (variant ImageGen) for a new image. Use `image_edit` (variant ImageEdit) only when the user supplied an existing image to change. Do not call video tools (`image_to_video`, `video_gen`, `reference_to_video`, or `/imagine-video`).

The image tool saves the file in Grok's session images directory. Do not copy, move, or rewrite that file. Do not create, edit, delete, or rename anything in the repository, and do not run shell commands. The client copies the session image into the workspace after the tool result reports its path.

If the image tool refuses because this account cannot generate images, repeat that refusal verbatim and stop. Do not describe a picture that was not generated and do not invent a file path.

After the tool finishes, reply with the saved path from the tool result and nothing else.
