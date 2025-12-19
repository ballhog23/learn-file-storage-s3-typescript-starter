
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
  console.log(tempFilePath);
  await Bun.write(tempFilePath, videoFile);
  let key = `${videoId}.mp4`;
  await uploadVideoToS3(cfg, key, tempFilePath, "video/mp4");

  const videoURL = `https://${cfg.s3Bucket}.s3.${cfg.s3Region}.amazonaws.com/${key}`;
  video.videoURL = videoURL;
  updateVideo(cfg.db, video);

  await Promise.all([rm(tempFilePath, { force: true })]);

  return respondWithJSON(200, video);
}
