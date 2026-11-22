import express from 'express';
import { CommentTarget } from './comment.service.js';

const json = express.json({ limit: '10kb' });

// 방송별 댓글: /api/broadcasts/:id/comments, /api/lives/:id/comments
//   GET  — 누구나 조회
//   POST — 로그인 회원만 작성 { body } (비로그인은 서비스에서 401)
export function createTargetCommentRouter({ service, targetType }) {
  const router = express.Router({ mergeParams: true });

  router.get('/', (req, res) => {
    res.json(service.list(targetType, Number(req.params.id)));
  });

  router.post('/', json, (req, res) => {
    const comment = service.create(targetType, Number(req.params.id), req.body?.body, req.member);
    res.status(201).json(comment);
  });

  return router;
}

// 댓글 하나: /api/comments/:commentId — 작성자만 수정·삭제(서비스에서 검사)
export function createCommentRouter({ service }) {
  const router = express.Router();

  router.patch('/:commentId', json, (req, res) => {
    res.json(service.update(Number(req.params.commentId), req.body?.body, req.member));
  });

  router.delete('/:commentId', (req, res) => {
    service.remove(Number(req.params.commentId), req.member);
    res.status(204).end();
  });

  return router;
}

export { CommentTarget };
