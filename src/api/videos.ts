
import { type ApiConfig } from "../config";
import { uploadVideoToS3 } from "../s3";
import { rm } from "fs/promises";
import path from "path";
import { file, s3, type BunRequest } from "bun";
import { getBearerToken, validateJWT } from "../auth";
import { getVideo, updateVideo } from "../db/videos";
import { respondWithJSON } from "./json";
import { BadRequestError, UserForbiddenError, NotFoundError } from "./errors";

export async function handlerUploadVideo(cfg: ApiConfig, req: BunRequest) {
  const MAX_UPLOAD_SIZE = 1 << 30; // 1GB

  const { videoId } = req.params as { videoId?: string; };
  if (!videoId) {
    throw new BadRequestError("Invalid video ID");
  }

  const token = getBearerToken(req.headers);
  const userID = validateJWT(token, cfg.jwtSecret);
  const video = getVideo(cfg.db, videoId);
  if (!video) {
    throw new NotFoundError("Couldn't find video");
  }
  if (video.userID !== userID) {
    throw new UserForbiddenError("Not Authorized.");
  }

  const formData = await req.formData();
  const videoFile = formData.get("video");
  if (!(videoFile instanceof File)) {
    throw new BadRequestError("Video file is missing");
  }

  if (videoFile.size > MAX_UPLOAD_SIZE) {
    throw new BadRequestError(`Video file exceeds the maximum allowed size of 1GB`);
  }

  const mediaType = videoFile.type;
  if (!mediaType) {
    throw new BadRequestError("Missing Content-Type for video");
  }

  const allowedMimeType = ['video/mp4'];

  if (!allowedMimeType.includes(mediaType)) {
    throw new BadRequestError("mp4 format required");
  }

  const tempFilePath = path.join("/tmp", `${videoId}.mp4`);

  await Bun.write(tempFilePath, videoFile);
  // read aspect ratio of tmp file, if i write here will it wait for bun.write? or should we wrap it in a promise.resolve.then
  const aspectRatio = await getVideoAspectRatio(tempFilePath);
  console.log('ASPECT RATIO: ', aspectRatio);
  let key = `${aspectRatio}/${videoId}.mp4`;
  console.log('KEY FOR S3: ', key);
  await uploadVideoToS3(cfg, key, tempFilePath, "video/mp4");

  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  console.log("CLICK HERE: ", videoURL);
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);

  await Promise.all([rm(tempFilePath, { force: true })]);

  return respondWithJSON(200, video);
}

// returns dynamic path for s3 key, union of landscape, portait, other
async function getVideoAspectRatio(filePath: string): Promise<"landscape" | "portrait" | "other"> {
  const process = Bun.spawn(
    [
      "ffprobe",
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height",
      "-of",
      "json",
      filePath,
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );

  const outputText = await new Response(process.stdout).text();
  const errorText = await new Response(process.stderr).text();

  const exitCode = await process.exited;

  if (exitCode !== 0) {
    throw new Error(`ffprobe error: ${errorText}`);
  }

  const output = JSON.parse(outputText);
  if (!output.streams || output.streams.length === 0) {
    throw new Error("No video streams found");
  }

  const { aspectRatio } = output;

  switch (aspectRatio) {
    case "16:9":
      return 'landscape';
    case "9:16":
      return 'portrait';
    default:
      return 'other';
  }
}