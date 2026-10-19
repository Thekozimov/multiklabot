# Multfilmlar Olami boti v3.1

## Talab
Node.js **24.21.0** yoki yangiroq (`nvm use` — `.nvmrc` mavjud). `dotenv` endi kerak emas, `.env` ni Node o'zi o'qiydi.

## Ishga tushirish
1. `.env.example` ni `.env` ga ko'chiring va `BOT_TOKEN`, `ADMIN_ID`, `CHANNEL_USERNAME` ni to'ldiring.
2. `npm install`
3. `npm start` (yoki Windows'da `start.bat` — bot to'xtasa o'zi qayta ishga tushadi; yoki `pm2 start ecosystem.config.js`).
4. Botni majburiy obuna kanalida **administrator** qiling (obunani tekshirish va avtomatik post uchun).
5. Inline rejim uchun: @BotFather → `/setinline`.

Eski `database.json` avtomatik yangi formatga o'tkaziladi (yaroqsiz `...` fileId li yozuvlar o'tkazib yuboriladi).

## Admin buyruqlari
Botga `/help` yozing. Asosiylari: video yuborish (yangi multfilm), `/addpart`, `/list`, `/edit`, `/delete`,
`/setcat`, `/settags`, `/cats`, `/addcat`, `/channels`, `/addchannel`, `/broadcast`, `/requests`, `/done`,
`/ban`, `/stats`, `/backup`, `/protect`, `/autopost`, `/addadmin`.

## Fayllar
- `database.json` — baza (har yozishda `.bak` zaxira nusxa saqlanadi, buzilsa o'zi tiklanadi)
- `backups/` — kunlik zaxira (oxirgi 7 ta), shuningdek har 24 soatda asosiy adminga yuboriladi
- `logs/bot.log` — xatolar logi
