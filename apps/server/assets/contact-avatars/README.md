# 联系人内置头像

从好得 APP 的 `app/assets/images/default_avatars/` 与 `app/lib/widgets/contact_avatar.dart` 原样引入，共 32 张 PNG；保留名称、分类和顺序。2026-10-04 由用户明确要求复用。catalog.json 记录每张图片的 SHA-256，服务端核对后使用。选择保存时复制到用户 Wiki，人物 Markdown 保持相对路径引用。发行构建随 server assets 整目录打包。
