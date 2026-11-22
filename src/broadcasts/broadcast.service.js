import { badRequest, notFound } from '../http/errors.js';
import { requireMember, requireOwner } from '../auth/access.js';

// 영상 위치의 종류. upload 는 업로드 디렉터리 안의 파일명, url 은 외부 http(s) 영상 주소를 뜻한다.
export const VideoSource = Object.freeze({ UPLOAD: 'upload', URL: 'url' });

const TITLE_MAX = 100;
const DESCRIPTION_MAX = 2000;

// 녹화방송 등록·조회·수정·삭제 규칙. HTTP나 SQL을 모르고, 저장소와 영상 저장소에만 의존한다.
// actor 는 요청한 회원(비로그인이면 null). 등록은 회원만, 수정·삭제는 소유자만 할 수 있다.
export function createBroadcastService({ repository, storage, comments }) {
  function find(id) {
    const broadcast = Number.isInteger(id) && id > 0 ? repository.findById(id) : null;
    if (!broadcast) throw notFound('방송을 찾을 수 없습니다.');
    return broadcast;
  }

  return {
    list() {
      return repository.findAll().map(toView);
    },

    get(id) {
      return toView(find(id));
    },

    // uploadedFile 은 이미 디스크에 저장된 파일이다. 거절하면 지워서 고아 파일을 남기지 않는다.
    register({ title, description, videoUrl, uploadedFile }, actor) {
      try {
        requireMember(actor);
        const fields = validate({ title, description, videoUrl, uploadedFile });
        const broadcast = uploadedFile
          ? repository.save({
              ...fields,
              sourceType: VideoSource.UPLOAD,
              videoLocation: uploadedFile.filename,
              mimeType: uploadedFile.mimetype,
              fileSize: uploadedFile.size,
              ownerId: actor.id,
            })
          : repository.save({
              ...fields,
              sourceType: VideoSource.URL,
              videoLocation: parseHttpUrl(videoUrl),
              ownerId: actor.id,
            });
        return toView(broadcast);
      } catch (err) {
        if (uploadedFile) storage.remove(uploadedFile.filename);
        throw err;
      }
    },

    // 제목·설명만 바꾼다. 영상은 교체하지 않는다.
    update(id, { title, description }, actor) {
      const broadcast = find(id);
      requireOwner(actor, broadcast);
      const fields = validateText({
        title: title ?? broadcast.title,
        description: description ?? broadcast.description,
      });
      return toView(repository.update(id, fields));
    },

    // 방송, 업로드된 영상 파일, 그 방송의 댓글을 함께 지운다.
    remove(id, actor) {
      const broadcast = find(id);
      requireOwner(actor, broadcast);
      comments.deleteAllFor('broadcast', id);
      repository.delete(id);
      if (broadcast.sourceType === VideoSource.UPLOAD) storage.remove(broadcast.videoLocation);
    },
  };

  // 플레이어가 그대로 <video src> 로 쓸 수 있는 videoSrc 를 붙인다.
  function toView(broadcast) {
    return {
      ...broadcast,
      videoSrc: broadcast.sourceType === VideoSource.UPLOAD
        ? storage.publicUrl(broadcast.videoLocation)
        : broadcast.videoLocation,
    };
  }
}

function validateText({ title, description }) {
  const cleanTitle = String(title ?? '').trim();
  const cleanDescription = String(description ?? '').trim();
  if (!cleanTitle) throw badRequest('제목을 입력해 주세요.');
  if (cleanTitle.length > TITLE_MAX) throw badRequest(`제목은 ${TITLE_MAX}자 이하여야 합니다.`);
  if (cleanDescription.length > DESCRIPTION_MAX) throw badRequest(`설명은 ${DESCRIPTION_MAX}자 이하여야 합니다.`);
  return { title: cleanTitle, description: cleanDescription };
}

function validate({ title, description, videoUrl, uploadedFile }) {
  const fields = validateText({ title, description });
  const hasUrl = String(videoUrl ?? '').trim() !== '';
  if (uploadedFile && hasUrl) throw badRequest('영상 파일과 영상 URL 중 하나만 입력해 주세요.');
  if (!uploadedFile && !hasUrl) throw badRequest('영상 파일을 업로드하거나 영상 URL을 입력해 주세요.');
  return fields;
}

function parseHttpUrl(value) {
  let url;
  try {
    url = new URL(String(value).trim());
  } catch {
    throw badRequest('영상 URL 형식이 올바르지 않습니다.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('영상 URL은 http:// 또는 https:// 로 시작해야 합니다.');
  }
  return url.href;
}
