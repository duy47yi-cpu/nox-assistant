#!/usr/bin/env python3
# NOX Phase 2.3 — 4 макета 1200x720
import os
from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 720
BG = "#0F0F10"
SURFACE = "#18181B"
SURFACE1 = "#141415"
SURFACE2 = "#1C1C1F"
SURFACE3 = "#232326"
BORDER = "#2A2A2E"
BORDER_STRONG = "#34343A"
TEXT1 = "#F1F1F3"
TEXT2 = "#9A9AA0"
TEXT3 = "#6B6B70"
GHOST = "#3A3A3E"
ACCENT = "#2E9AC1"
ACCENT_HOVER = "#3AAAD6"
ACCENT_SOFT = "#1A2A31"  # approx 14% #2E9AC1 on #18181B
ACCENT_SOFT2 = "#1E3340"
OK = "#3DD68C"
WARN = "#F5A524"
ERR = "#FF5C5C"

OUT = "docs/reconstruction/phase2/design/previews"
os.makedirs(OUT, exist_ok=True)

# Fonts
FONT_PATH = "apps/jarvis-desktop/renderer/fonts/Inter-Variable.ttf"
FONT_MONO_PATH = "C:/Windows/Fonts/consola.ttf"  # fallback mono
try:
    # test
    pass
except:
    pass

def load_font(size, weight=400):
    try:
        # Inter Variable supports weight via instance but Pillow will just use size
        return ImageFont.truetype(FONT_PATH, size)
    except:
        return ImageFont.load_default()

def load_mono(size):
    for p in ["C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/Consolas.ttf", "C:/Windows/Fonts/cascadia.ttf"]:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except: pass
    try: return ImageFont.truetype(FONT_MONO_PATH, size)
    except: return ImageFont.load_default()

# Preload fonts
font_title = load_font(24)
font_section = load_font(15)
font_body = load_font(13)
font_body_b = load_font(13)
font_body_sm = load_font(12)
font_meta = load_font(11)
font_caption = load_font(10)
font_mono = load_mono(11)
font_mono_sm = load_mono(10)
font_icon = load_font(14)
font_rail = load_font(11)

def hex_to_rgb(h):
    h=h.lstrip('#')
    return tuple(int(h[i:i+2],16) for i in (0,2,4))

def rounded_rect(draw, xy, r, fill=None, outline=None, width=1):
    # xy: (x0,y0,x1,y1)
    draw.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)

def draw_rail(draw):
    # Rail background: x 8 y 8 w 52 h 704
    x, y, w, h = 8, 8, 52, 704
    # Draw combined rail panel
    rounded_rect(draw, (x, y, x+w, y+h), 16, fill=hex_to_rgb(SURFACE), outline=hex_to_rgb(BORDER), width=1)
    # inner: cover right edge to merge with next panel — we'll just keep rounded fully for preview simplicity but add right border removal effect
    # Logo circle
    cx, cy = x+26, y+28
    draw.ellipse((cx-16, cy-16, cx+16, cy+16), fill=None, outline=hex_to_rgb(TEXT1), width=2)
    draw.ellipse((cx+6, cy-10, cx+12, cy-4), fill=hex_to_rgb(BG))
    # nav items
    items = [
        (0, "⌂", True),
        (1, "◫", False),
        (2, "◷", False),
        (3, "◈", False),
        (4, "⚙", False),
    ]
    # Map per screen active later, but default active chat
    # We'll draw generic rail; caller will highlight specific
    # We'll not draw text labels

def draw_rail_with_active(draw, active_idx):
    x, y, w, h = 8, 8, 52, 704
    rounded_rect(draw, (x, y, x+w, y+h), 16, fill=hex_to_rgb(SURFACE), outline=hex_to_rgb(BORDER), width=1)
    # remove right border visual — draw over it with surface
    # Logo
    cx, cy = x+26, y+28
    draw.ellipse((cx-13, cy-13, cx+13, cy+13), fill=None, outline=hex_to_rgb(TEXT1), width=1)
    draw.ellipse((cx+5, cy-8, cx+10, cy-3), fill=hex_to_rgb(SURFACE))
    # icons
    icons = ["⌂", "≡", "◷", "⬡", "⚙"]
    # positions
    start_y = y+62
    for i, ic in enumerate(icons):
        iy = start_y + i*44
        bx = x+8
        by = iy
        bw, bh = 36, 36
        is_active = (i == active_idx)
        if is_active:
            # accent soft bg
            rounded_rect(draw, (bx, by, bx+bw, by+bh), 10, fill=hex_to_rgb(ACCENT_SOFT), outline=None)
            # left bar
            draw.rounded_rectangle((x-1, by+7, x+3, by+29), radius=2, fill=hex_to_rgb(ACCENT))
        else:
            # hover none, just base
            pass
        # icon text
        col = hex_to_rgb(ACCENT) if is_active else hex_to_rgb(TEXT3)
        # draw icon char centered
        # use font_icon
        # get bbox
        try:
            bbox = draw.textbbox((0,0), ic, font=font_icon)
            tw = bbox[2]-bbox[0]; th = bbox[3]-bbox[1]
        except:
            tw, th = (12,12)
        tx = bx + (bw - tw)//2
        ty = by + (bh - th)//2 -1
        draw.text((tx, ty), ic, fill=col, font=font_icon)
        # notification dot on history if needed
        if i==2 and active_idx==2:
            # small dot
            pass
    # bottom account
    ax, ay = x+10, y+h-36
    draw.ellipse((ax, ay, ax+32, ay+32), fill=None, outline=hex_to_rgb(BORDER), width=1)
    draw.text((ax+10, ay+8), "◉", fill=hex_to_rgb(TEXT2), font=font_icon)
    # account dot
    draw.ellipse((ax+22, ay+2, ax+28, ay+8), fill=hex_to_rgb(ACCENT))

def draw_header(draw, title, subtitle=None, with_new=False):
    # header inside main panel: x 68 w 1092? Actually app 8+52=60, workspace 60-> 
    # For preview we use: main area x 68 y 16? Let's define workspace
    # We'll define: content origin ox=68, oy=16, ow=1116 (1200-8-52-8-8? approx)
    # But spec says x80 y72 w1092; we'll use ox=72 for visual
    # Simpler: header rect
    ox, oy, ow = 68, 16, 1116
    # Draw main container bg
    # This is called after rail, but we need to draw main panel already
    # Title
    draw.text((ox+20, oy+14), title, fill=hex_to_rgb(TEXT1), font=font_title)
    if subtitle:
        draw.text((ox+20, oy+38), subtitle, fill=hex_to_rgb(TEXT2), font=font_body_sm)
    if with_new:
        # New button 112x40 accent
        bx = ox+ow-132
        by = oy+12
        rounded_rect(draw, (bx, by, bx+112, by+36), 8, fill=hex_to_rgb(ACCENT))
        draw.text((bx+18, by+10), "+  Новая", fill=hex_to_rgb("#061217"), font=font_body)
    return ox, oy, ow

def draw_window_chrome(draw):
    # window border outer
    rounded_rect(draw, (8,8, W-8, H-8), 12, fill=None, outline=hex_to_rgb(BORDER), width=1)
    # top right window controls
    cx = W-8-60
    cy = 20
    draw.text((cx, cy), "—   □   ×", fill=hex_to_rgb(TEXT3), font=font_body_sm)

# ---------- MOCK 1: Commands catalog ----------
def make_commands():
    img = Image.new("RGB", (W,H), hex_to_rgb(BG))
    draw = ImageDraw.Draw(img)
    draw_window_chrome(draw)
    draw_rail_with_active(draw, 1)  # commands active

    # Main workspace panel
    ox, oy, ow = 68, 16, W-68-8  # 1124
    # Main bg panel
    rounded_rect(draw, (ox, oy, ox+ow, oy+H-24), 16, fill=hex_to_rgb(SURFACE), outline=hex_to_rgb(BORDER))
    # Header
    draw.text((ox+20, oy+16), "Команды", fill=hex_to_rgb(TEXT1), font=font_title)
    # New button
    bx = ox+ow-132
    by = oy+14
    rounded_rect(draw, (bx, by, bx+112, by+36), 8, fill=hex_to_rgb(ACCENT))
    draw.text((bx+22, by+10), "+  Новая", fill=hex_to_rgb("#061217"), font=font_body)
    # divider
    draw.line((ox, oy+64, ox+ow, oy+64), fill=hex_to_rgb(BORDER), width=1)

    # Toolbar: tabs + search + actions
    ty = oy+78
    # tabs
    tabs = [("Мои · 12", True), ("Библиотека · 36", False)]
    tx = ox+20
    for label, active in tabs:
        tw = 110 if "Мои" in label else 130
        th = 32
        if active:
            rounded_rect(draw, (tx, ty, tx+tw, ty+th), 8, fill=hex_to_rgb(ACCENT_SOFT), outline=hex_to_rgb("#2E9AC1"))
            col = hex_to_rgb(ACCENT)
        else:
            rounded_rect(draw, (tx, ty, tx+tw, ty+th), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
            col = hex_to_rgb(TEXT2)
        draw.text((tx+16, ty+8), label, fill=col, font=font_body_sm)
        tx += tw+8
    # search
    sx = ox+20+260
    # Actually tabs width ~240, search at 280
    sx = ox+268
    rounded_rect(draw, (sx, ty, sx+220, ty+32), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((sx+10, ty+8), "🔍  Поиск по имени и фразам…", fill=hex_to_rgb(TEXT2), font=font_body_sm)
    # actions right
    ax = ox+ow-20
    for lbl in ["Экспорт", "Импорт", "Записать"]:
        tw = 76 if lbl!="Записать" else 84
        ax -= tw+8
        rounded_rect(draw, (ax, ty, ax+tw, ty+32), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
        draw.text((ax+12, ty+8), lbl, fill=hex_to_rgb(TEXT2), font=font_body_sm)
        if lbl=="Записать":
            draw.ellipse((ax+12, ty+11, ax+18, ty+17), fill=hex_to_rgb(ERR))

    # Divider second
    draw.line((ox, ty+44, ox+ow, ty+44), fill=hex_to_rgb(BORDER), width=1)

    # Content area: main list 800 + packs 280
    cy = ty+56
    # Left main list panel
    list_w = 782
    packs_w = 268
    gap = 12
    # list container
    rounded_rect(draw, (ox+20, cy, ox+20+list_w, cy+460), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
    # rows
    rows = [
        ("Включи Spotify", "включи спотифай · открой музыку", "Музыка · 3 шага", "▶", True, False),
        ("Разобрать входящие", "разбери почту · входящие", "Почта · 5 шагов", "▶", False, True),
        ("Сделать скриншот", "сделай скрин · скринь экран", "Система · 1 шаг", "▶", False, False),
        ("Тихий режим", "тихий режим · не беспокоить", "Система · 2 шага", "▶", False, False),
        ("Открыть Figma", "открой фигму · фигма", "Дизайн · 2 шага", "▶", False, False),
        ("Перевести текст", "переведи · перевод", "Текст · 2 шага", "▶", False, False),
    ]
    ry = cy+12
    for idx, (name, phrases, meta, btn, expanded, disabled) in enumerate(rows):
        rh = 62 if not expanded else 98
        # row bg
        if expanded:
            rounded_rect(draw, (ox+28, ry, ox+28+list_w-16, ry+rh), 10, fill=hex_to_rgb(SURFACE3), outline=hex_to_rgb(BORDER_STRONG))
        else:
            rounded_rect(draw, (ox+28, ry, ox+28+list_w-16, ry+rh), 10, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
        # chevron
        draw.text((ox+38, ry+12), "›" if not expanded else "⌄", fill=hex_to_rgb(TEXT3), font=font_icon)
        # name
        draw.text((ox+54, ry+10), name, fill=hex_to_rgb(TEXT1 if not disabled else GHOST), font=font_body)
        # phrases chips
        px = ox+54
        py = ry+28
        for phrase in phrases.split(" · ")[:2]:
            # chip
            chip_w = len(phrase)*6+14
            rounded_rect(draw, (px, py, px+chip_w, py+16), 8, fill=hex_to_rgb(SURFACE3), outline=hex_to_rgb(BORDER))
            draw.text((px+6, py+2), phrase, fill=hex_to_rgb(TEXT2), font=font_caption)
            px += chip_w+6
        # meta
        draw.text((ox+54, ry+46), meta, fill=hex_to_rgb(TEXT2), font=font_meta)
        # actions right
        # toggle
        tx2 = ox+28+list_w-16-96
        # run button
        rounded_rect(draw, (tx2, ry+10, tx2+72, ry+30), 8, fill=hex_to_rgb(SURFACE3), outline=hex_to_rgb(BORDER))
        draw.text((tx2+16, ry+14), "Запустить", fill=hex_to_rgb(TEXT2), font=font_caption)
        # toggle switch
        sx2 = ox+28+list_w-16-24
        sy2 = ry+38
        # track
        track_col = hex_to_rgb(ACCENT) if not disabled else hex_to_rgb(GHOST)
        # draw track
        rounded_rect(draw, (sx2-12, sy2, sx2+16, sy2+16), 8, fill=track_col, outline=None)
        # thumb
        thumb_x = sx2+8 if not disabled else sx2-4
        draw.ellipse((thumb_x-4, sy2+2, thumb_x+8, sy2+14), fill=hex_to_rgb("#FFFFFF"))
        # expanded preview
        if expanded:
            draw.text((ox+54, ry+66), "1. app_open  Открыть Spotify  2. wait 1200ms  3. ui_keys Enter", fill=hex_to_rgb(TEXT2), font=font_mono_sm)
            if disabled:
                # strikethrough hint
                draw.text((ox+54, ry+80), "Выключена — запуск недоступен", fill=hex_to_rgb(TEXT3), font=font_meta)
        ry += rh+8
        if ry > cy+440: break

    # Packs panel
    px = ox+20+list_w+gap
    py = cy
    rounded_rect(draw, (px, py, px+packs_w, py+460), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
    draw.text((px+14, py+14), "Готовые паки", fill=hex_to_rgb(TEXT1), font=font_section)
    draw.text((px+14, py+32), "9 паков · установка по клику", fill=hex_to_rgb(TEXT2), font=font_meta)
    # pack cards
    packs = [
        ("Монтаж", "8 команд", "Не установлено", "Установить"),
        ("Браузер", "12 команд", "Установлено 4 из 12", "Дополнить"),
        ("Текст", "6 команд", "Все установлено", "✓ Установлено"),
    ]
    py2 = py+56
    for name, count, state, btn in packs:
        rounded_rect(draw, (px+10, py2, px+packs_w-10, py2+76), 10, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
        draw.text((px+20, py2+10), name, fill=hex_to_rgb(TEXT1), font=font_body)
        draw.text((px+20, py2+28), count + " · " + state, fill=hex_to_rgb(TEXT2), font=font_meta)
        # btn
        bw = 96
        bx2 = px+packs_w-10-bw-8
        by2 = py2+46
        if "Установлено" in btn and "Все" in state:
            rounded_rect(draw, (bx2, by2, bx2+bw, by2+22), 8, fill=hex_to_rgb(SURFACE3), outline=hex_to_rgb(BORDER))
            draw.text((bx2+12, by2+5), btn, fill=hex_to_rgb(GHOST), font=font_caption)
        elif "Дополнить" in btn:
            rounded_rect(draw, (bx2, by2, bx2+bw, by2+22), 8, fill=hex_to_rgb(SURFACE3), outline=hex_to_rgb(BORDER))
            draw.text((bx2+18, by2+5), btn, fill=hex_to_rgb(TEXT2), font=font_caption)
        else:
            rounded_rect(draw, (bx2, by2, bx2+bw, by2+22), 8, fill=hex_to_rgb(ACCENT), outline=None)
            draw.text((bx2+18, by2+5), btn, fill=hex_to_rgb("#061217"), font=font_caption)
        # disclosure
        draw.text((px+20, py2+52), "Что внутри ▾", fill=hex_to_rgb(ACCENT), font=font_caption)
        py2 += 84
    # footer hint
    draw.text((px+14, py+340), "Все паки хранятся локально", fill=hex_to_rgb(TEXT3), font=font_meta)

    img.save(f"{OUT}/01-commands.png", "PNG")
    print("saved 01")

# ---------- MOCK 2: Editor ----------
def make_editor():
    img = Image.new("RGB", (W,H), hex_to_rgb(BG))
    draw = ImageDraw.Draw(img)
    draw_window_chrome(draw)
    draw_rail_with_active(draw, 1)

    ox, oy, ow = 68, 16, W-68-8
    rounded_rect(draw, (ox, oy, ox+ow, oy+H-24), 16, fill=hex_to_rgb(SURFACE), outline=hex_to_rgb(BORDER))
    # Header with breadcrumb
    draw.text((ox+20, oy+16), "←  Команды / Включи Spotify", fill=hex_to_rgb(TEXT2), font=font_body)
    draw.text((ox+20, oy+32), "Редактирование команды", fill=hex_to_rgb(TEXT1), font=font_body)
    # window controls already
    draw.line((ox, oy+56, ox+ow, oy+56), fill=hex_to_rgb(BORDER), width=1)

    # Main editor layout: left 724 (actually 740) + right 340
    cy = oy+68
    left_w = 740
    right_w = 340
    gap = 12
    # left card
    lx, ly = ox+20, cy
    rounded_rect(draw, (lx, ly, lx+left_w, ly+568), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
    # right result panel sticky
    rx = lx+left_w+gap
    rounded_rect(draw, (rx, ly, rx+right_w, ly+240), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
    # left content
    pad = 16
    # Name field
    draw.text((lx+pad, ly+14), "Имя команды", fill=hex_to_rgb(TEXT2), font=font_meta)
    rounded_rect(draw, (lx+pad, ly+32, lx+left_w-pad, ly+64), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((lx+pad+10, ly+40), "Включи Spotify", fill=hex_to_rgb(TEXT1), font=font_body)
    # cursor
    draw.line((lx+pad+10+96, ly+38, lx+pad+10+96, ly+56), fill=hex_to_rgb(ACCENT), width=1)
    # Phrases
    draw.text((lx+pad, ly+78), "Фразы для запуска", fill=hex_to_rgb(TEXT2), font=font_meta)
    # chips
    px = lx+pad
    py = ly+96
    for phrase in ["включи спотифай", "открой музыку", "спотифай"]:
        chip_w = len(phrase)*6+20
        rounded_rect(draw, (px, py, px+chip_w, py+22), 12, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
        draw.text((px+8, py+5), phrase, fill=hex_to_rgb(TEXT1), font=font_caption)
        draw.text((px+chip_w-12, py+4), "×", fill=hex_to_rgb(TEXT3), font=font_caption)
        px += chip_w+8
    # add field
    rounded_rect(draw, (px, py, px+120, py+22), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((px+10, py+5), "+ Добавить фразу", fill=hex_to_rgb(TEXT3), font=font_caption)
    draw.text((lx+left_w-pad-30, py+5), "3/5", fill=hex_to_rgb(TEXT2), font=font_meta)
    # Folder | Hotkey
    draw.text((lx+pad, ly+132), "Папка", fill=hex_to_rgb(TEXT2), font=font_meta)
    draw.text((lx+left_w//2+8, ly+132), "Горячая клавиша", fill=hex_to_rgb(TEXT2), font=font_meta)
    rounded_rect(draw, (lx+pad, ly+148, lx+left_w//2-4, ly+176), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((lx+pad+10, ly+156), "Музыка", fill=hex_to_rgb(TEXT1), font=font_body_sm)
    rounded_rect(draw, (lx+left_w//2+8, ly+148, lx+left_w-pad, ly+176), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((lx+left_w//2+18, ly+156), "Ctrl+Shift+S", fill=hex_to_rgb(TEXT1), font=font_mono)
    # Origin
    draw.text((lx+pad, ly+188), "Происхождение: Создана вручную", fill=hex_to_rgb(TEXT2), font=font_meta)
    # Warning banner
    rounded_rect(draw, (lx+pad, ly+206, lx+left_w-pad, ly+230), 8, fill=hex_to_rgb("#2A2410"), outline=hex_to_rgb(WARN))
    draw.text((lx+pad+8, ly+212), "⚠  Координаты экрана могут отличаться на другом мониторе", fill=hex_to_rgb(WARN), font=font_meta)
    # Steps header
    draw.text((lx+pad, ly+244), "Шаги  3/20", fill=hex_to_rgb(TEXT1), font=font_section)
    rounded_rect(draw, (lx+left_w-pad-110, ly+240, lx+left_w-pad, ly+264), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((lx+left_w-pad-96, ly+246), "+ Добавить действие", fill=hex_to_rgb(TEXT2), font=font_caption)

    # Steps list
    sy = ly+276
    steps = [
        ("1", "app_open", "Открыть Spotify", "Открывает приложение по имени", [("Приложение *", "Spotify")], False),
        ("2", "wait", "Пауза", "Ждёт 1.2 секунды", [("Задержка, мс", "1200")], False),
        ("3", "ui_keys", "Нажать клавиши", "Отправляет сочетание клавиш", [("Клавиши *", "MediaPlayPause")], True),
    ]
    for num, tool, title, desc, fields, selected in steps:
        sh = 86 if len(fields)==1 else 86
        if selected:
            rounded_rect(draw, (lx+pad, sy, lx+left_w-pad, sy+sh), 10, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(ACCENT))
        else:
            rounded_rect(draw, (lx+pad, sy, lx+left_w-pad, sy+sh), 10, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
        # number
        draw.text((lx+pad+8, sy+10), num, fill=hex_to_rgb(TEXT3), font=font_mono)
        # tool select
        sel_w = 110
        rounded_rect(draw, (lx+pad+24, sy+6, lx+pad+24+sel_w, sy+26), 8, fill=hex_to_rgb(SURFACE3), outline=hex_to_rgb(BORDER))
        draw.text((lx+pad+32, sy+10), tool, fill=hex_to_rgb(TEXT1), font=font_mono_sm)
        draw.text((lx+pad+24+sel_w-14, sy+8), "▾", fill=hex_to_rgb(TEXT3), font=font_caption)
        # title
        draw.text((lx+pad+24+sel_w+10, sy+10), title, fill=hex_to_rgb(TEXT1), font=font_body_sm)
        # risk pill if any
        if tool=="ui_keys":
            rounded_rect(draw, (lx+left_w-pad-60, sy+8, lx+left_w-pad-20, sy+22), 6, fill=hex_to_rgb(SURFACE3), outline=hex_to_rgb(BORDER))
            draw.text((lx+left_w-pad-54, sy+10), "T1", fill=hex_to_rgb(TEXT2), font=font_caption)
        # move/delete
        draw.text((lx+left_w-pad-50, sy+36), "↑  ↓  ×", fill=hex_to_rgb(TEXT3), font=font_caption)
        # desc
        draw.text((lx+pad+24, sy+32), desc, fill=hex_to_rgb(TEXT2), font=font_meta)
        # fields
        fy = sy+48
        for label, val in fields:
            draw.text((lx+pad+24, fy), label, fill=hex_to_rgb(TEXT2), font=font_meta)
            # input
            ix = lx+pad+140
            rounded_rect(draw, (ix, fy-4, lx+left_w-pad-20, fy+18), 8, fill=hex_to_rgb(SURFACE3), outline=hex_to_rgb(BORDER) if not selected else hex_to_rgb(ACCENT))
            draw.text((ix+8, fy), val, fill=hex_to_rgb(TEXT1), font=font_body_sm)
            fy += 24
        sy += sh+8

    # Footer
    fy = ly+568-36
    draw.line((lx, ly+568-44, lx+left_w, ly+568-44), fill=hex_to_rgb(BORDER), width=1)
    # left delete
    rounded_rect(draw, (lx+pad, fy, lx+pad+88, fy+28), 8, fill=None, outline=hex_to_rgb(ERR))
    draw.text((lx+pad+22, fy+7), "Удалить", fill=hex_to_rgb(ERR), font=font_body_sm)
    # right buttons
    bx = lx+left_w-pad
    for lbl, accent in [("Сохранить", True), ("Отмена", False), ("Запустить сейчас", False), ("Проверить", False)][::-1]:
        tw = 96 if lbl!="Запустить сейчас" else 120
        if lbl=="Сохранить":
            tw=88
        bx -= tw+8
        if accent:
            rounded_rect(draw, (bx, fy, bx+tw, fy+28), 8, fill=hex_to_rgb(ACCENT))
            draw.text((bx+12, fy+7), lbl, fill=hex_to_rgb("#061217"), font=font_body_sm)
        else:
            col = hex_to_rgb(TEXT2)
            if lbl=="Проверить":
                col = hex_to_rgb(TEXT2)
            rounded_rect(draw, (bx, fy, bx+tw, fy+28), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
            draw.text((bx+12, fy+7), lbl, fill=col, font=font_body_sm)
    # Result panel
    draw.text((rx+14, ly+14), "Результат проверки", fill=hex_to_rgb(TEXT1), font=font_section)
    draw.text((rx+14, ly+32), "Без запуска — только текст шагов", fill=hex_to_rgb(TEXT2), font=font_meta)
    # status rows
    ry = ly+52
    for step, status, col in [("1. app_open Spotify", "ok", OK), ("2. wait 1200ms", "ok", OK), ("3. ui_keys MediaPlayPause", "ok", OK)]:
        draw.text((rx+14, ry), "●", fill=hex_to_rgb(col), font=font_caption)
        draw.text((rx+26, ry), step, fill=hex_to_rgb(TEXT2), font=font_mono_sm)
        rounded_rect(draw, (rx+14, ry+14, rx+right_w-14, ry+24), 6, fill=hex_to_rgb(SURFACE2), outline=None)
        draw.text((rx+20, ry+15), "готов к сохранению", fill=hex_to_rgb(TEXT3), font=font_meta)
        ry+=32
    # hint
    rounded_rect(draw, (rx+14, ry+12, rx+right_w-14, ry+48), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((rx+20, ry+16), "ℹ  Сохранение не запускает команду.", fill=hex_to_rgb(TEXT2), font=font_meta)
    draw.text((rx+20, ry+30), "Нажмите «Запустить сейчас» после.", fill=hex_to_rgb(TEXT3), font=font_meta)

    # Result panel details already drawn, no overlay
    img.save(f"{OUT}/02-editor.png", "PNG")
    print("saved 02")

# ---------- MOCK 3: Connections ----------
def make_connections():
    img = Image.new("RGB", (W,H), hex_to_rgb(BG))
    draw = ImageDraw.Draw(img)
    draw_window_chrome(draw)
    draw_rail_with_active(draw, 3) # connections

    ox, oy, ow = 68, 16, W-68-8
    rounded_rect(draw, (ox, oy, ox+ow, oy+H-24), 16, fill=hex_to_rgb(SURFACE), outline=hex_to_rgb(BORDER))
    draw.text((ox+20, oy+16), "Подключения", fill=hex_to_rgb(TEXT1), font=font_title)
    bx = ox+ow-164
    rounded_rect(draw, (bx, oy+14, bx+144, oy+50), 8, fill=hex_to_rgb(ACCENT))
    draw.text((bx+16, oy+24), "+  Добавить сервис", fill=hex_to_rgb("#061217"), font=font_body_sm)
    draw.line((ox, oy+64, ox+ow, oy+64), fill=hex_to_rgb(BORDER), width=1)

    # Toolbar: search + filters
    ty = oy+78
    rounded_rect(draw, (ox+20, ty, ox+320, ty+32), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((ox+30, ty+8), "🔍  Поиск сервисов…", fill=hex_to_rgb(TEXT2), font=font_body_sm)
    # filters chips
    fx = ox+340
    for label, active in [("Все", True), ("Подключённые", False), ("Выключенные", False), ("Ошибка", False)]:
        tw = len(label)*6+20
        if active:
            rounded_rect(draw, (fx, ty, fx+tw, ty+28), 12, fill=hex_to_rgb(ACCENT_SOFT), outline=hex_to_rgb(ACCENT))
            col = hex_to_rgb(ACCENT)
        else:
            rounded_rect(draw, (fx, ty, fx+tw, ty+28), 12, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
            col = hex_to_rgb(TEXT2)
        draw.text((fx+10, ty+7), label, fill=col, font=font_caption)
        fx += tw+8

    # Content: list 720 + popular 360
    cy = ty+48
    list_w = 700
    pop_w = 340
    # list container
    # cards
    cards = [
        ("Файлы проекта", "npx -y @mcp/filesystem  /data", "Подключён · 8 действий", OK, "Подключён", False, False),
        ("Браузер", "npx -y @mcp/puppeteer", "Подключён · 12 действий", OK, "Подключён", False, False),
        ("Заметки Obsidian", "npx -y @mcp/obsidian  /vault", "Подключается", ACCENT, "Подключается", False, True),
        ("Календарь", "https://mcp.example.com/calendar", "Ошибка: ECONNREFUSED", ERR, "Ошибка", True, False),
        ("База знаний", "npx -y @mcp/memory", "Выключен", GHOST, "Выключен", False, False),
        ("Notion", "npx -y @mcp/notion", "Изменения инструментов", WARN, "Drift", False, False),
    ]
    ry = cy
    for name, target, info, col, pill, has_err, is_connecting in cards:
        rh = 92 if has_err or col==WARN else 88
        rounded_rect(draw, (ox+20, ry, ox+20+list_w, ry+rh), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
        # icon 32
        rounded_rect(draw, (ox+32, ry+14, ox+64, ry+46), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
        draw.text((ox+40, ry+20), "⬡", fill=hex_to_rgb(TEXT3), font=font_icon)
        # name + pill
        draw.text((ox+74, ry+12), name, fill=hex_to_rgb(TEXT1), font=font_body)
        # pill
        pill_w = 78 if "Подключён" in pill else 84
        pill_x = ox+74 + len(name)*7+12
        # pill bg by status
        if col==OK:
            bg = hex_to_rgb("#1A2E24"); border_c = hex_to_rgb(OK); txt_c = hex_to_rgb(OK)
        elif col==ACCENT:
            bg = hex_to_rgb(ACCENT_SOFT); border_c = hex_to_rgb(ACCENT); txt_c = hex_to_rgb(ACCENT)
        elif col==ERR:
            bg = hex_to_rgb("#2E1A1E"); border_c = hex_to_rgb(ERR); txt_c = hex_to_rgb(ERR)
        elif col==WARN:
            bg = hex_to_rgb("#2E2410"); border_c = hex_to_rgb(WARN); txt_c = hex_to_rgb(WARN)
        else:
            bg = hex_to_rgb(SURFACE2); border_c = hex_to_rgb(BORDER); txt_c = hex_to_rgb(TEXT2)
        rounded_rect(draw, (pill_x, ry+12, pill_x+pill_w, ry+26), 10, fill=bg, outline=border_c)
        draw.text((pill_x+8, ry+14), "● " + pill, fill=txt_c, font=font_caption)
        # target mono
        draw.text((ox+74, ry+32), target, fill=hex_to_rgb(TEXT2), font=font_mono_sm)
        # info
        draw.text((ox+74, ry+48), info, fill=hex_to_rgb(TEXT2), font=font_meta)
        # actions right
        if col==WARN:
            # drift confirm
            rounded_rect(draw, (ox+20+list_w-160, ry+48, ox+20+list_w-16, ry+72), 8, fill=hex_to_rgb(ACCENT))
            draw.text((ox+20+list_w-142, ry+54), "Подтвердить изменения", fill=hex_to_rgb("#061217"), font=font_caption)
        elif has_err:
            rounded_rect(draw, (ox+20+list_w-90, ry+48, ox+20+list_w-16, ry+72), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
            draw.text((ox+20+list_w-76, ry+54), "Повторить", fill=txt_c, font=font_caption)
        elif not is_connecting and col!=GHOST:
            # toggle
            rounded_rect(draw, (ox+20+list_w-90, ry+12, ox+20+list_w-16, ry+32), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
            draw.text((ox+20+list_w-74, ry+16), "Детали", fill=hex_to_rgb(TEXT2), font=font_caption)
        elif col==GHOST:
            rounded_rect(draw, (ox+20+list_w-90, ry+12, ox+20+list_w-16, ry+32), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
            draw.text((ox+20+list_w-78, ry+16), "Включить", fill=hex_to_rgb(TEXT2), font=font_caption)
        ry += rh+8
        if ry > H-30: break

    # Popular panel
    px = ox+20+list_w+12
    py = cy
    rounded_rect(draw, (px, py, px+pop_w, py+520), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
    draw.text((px+14, py+14), "Популярные", fill=hex_to_rgb(TEXT1), font=font_section)
    # cats
    cx = px+14
    cy2 = py+40
    for cat, active in [("Все", True), ("Файлы", False), ("Разработка", False), ("Прочее", False)]:
        tw = len(cat)*6+16
        if active:
            rounded_rect(draw, (cx, cy2, cx+tw, cy2+22), 12, fill=hex_to_rgb(ACCENT_SOFT), outline=hex_to_rgb(ACCENT))
            col = hex_to_rgb(ACCENT)
        else:
            rounded_rect(draw, (cx, cy2, cx+tw, cy2+22), 12, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
            col = hex_to_rgb(TEXT2)
        draw.text((cx+8, cy2+5), cat, fill=col, font=font_caption)
        cx += tw+6
    # popular rows
    rows = [
        ("Filesystem", "Работа с файлами"),
        ("Puppeteer", "Автоматизация браузера"),
        ("Memory", "Хранилище заметок"),
        ("Postgres", "База данных"),
        ("Slack", "Сообщения команды"),
        ("GitHub", "Репозитории и PR"),
        ("Google Drive", "Документы и файлы"),
    ]
    ry2 = cy2+32
    for name, desc in rows:
        rounded_rect(draw, (px+10, ry2, px+pop_w-10, ry2+44), 10, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
        rounded_rect(draw, (px+18, ry2+8, px+46, ry2+36), 8, fill=hex_to_rgb(SURFACE3), outline=hex_to_rgb(BORDER))
        draw.text((px+24, ry2+14), "⬡", fill=hex_to_rgb(TEXT3), font=font_caption)
        draw.text((px+54, ry2+10), name, fill=hex_to_rgb(TEXT1), font=font_body_sm)
        draw.text((px+54, ry2+24), desc, fill=hex_to_rgb(TEXT2), font=font_meta)
        rounded_rect(draw, (px+pop_w-64, ry2+12, px+pop_w-16, ry2+32), 8, fill=hex_to_rgb(SURFACE3), outline=hex_to_rgb(BORDER))
        draw.text((px+pop_w-56, ry2+16), "+ Добавить", fill=hex_to_rgb(TEXT2), font=font_caption)
        ry2 += 52

    img.save(f"{OUT}/03-connections.png", "PNG")
    print("saved 03")

# ---------- MOCK 4: Settings ----------
def make_settings():
    img = Image.new("RGB", (W,H), hex_to_rgb(BG))
    draw = ImageDraw.Draw(img)
    draw_window_chrome(draw)
    draw_rail_with_active(draw, 4) # settings

    ox, oy, ow = 68, 16, W-68-8
    rounded_rect(draw, (ox, oy, ox+ow, oy+H-24), 16, fill=hex_to_rgb(SURFACE), outline=hex_to_rgb(BORDER))
    draw.text((ox+20, oy+16), "Настройки", fill=hex_to_rgb(TEXT1), font=font_title)
    draw.line((ox, oy+56, ox+ow, oy+56), fill=hex_to_rgb(BORDER), width=1)

    # workspace: nav 252 + main 828
    wy = oy+68
    nav_w = 244
    main_w = ow - nav_w - 32 - 12
    # nav panel
    nx, ny = ox+12, wy
    rounded_rect(draw, (nx, ny, nx+nav_w, ny+560), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
    # search
    rounded_rect(draw, (nx+10, ny+10, nx+nav_w-10, ny+38), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((nx+18, ny+16), "🔍  Поиск настроек…", fill=hex_to_rgb(TEXT2), font=font_body_sm)
    # chips
    cx = nx+10
    cy = ny+48
    for cat, active in [("Все", True), ("ИИ", False), ("Вид", False), ("Голос", False)]:
        tw = len(cat)*7+16
        if active:
            rounded_rect(draw, (cx, cy, cx+tw, cy+22), 12, fill=hex_to_rgb(ACCENT_SOFT), outline=hex_to_rgb(ACCENT))
            col = hex_to_rgb(ACCENT)
        else:
            rounded_rect(draw, (cx, cy, cx+tw, cy+22), 12, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
            col = hex_to_rgb(TEXT2)
        draw.text((cx+8, cy+5), cat, fill=col, font=font_caption)
        cx += tw+6
    # nav items
    items = [
        ("Общие", False),
        ("ИИ и провайдеры", True),
        ("Голос и память", False),
        ("Внешний вид", False),
        ("Сфера Nox", False),
        ("Безопасность", False),
    ]
    iy = cy+30
    for label, active in items:
        if active:
            rounded_rect(draw, (nx+10, iy, nx+nav_w-10, iy+32), 8, fill=hex_to_rgb(ACCENT_SOFT), outline=hex_to_rgb(ACCENT))
            col = hex_to_rgb(ACCENT)
            # left accent bar? for nav inside settings use bg only
        else:
            col = hex_to_rgb(TEXT2)
        # icon placeholder
        draw.text((nx+18, iy+8), "•", fill=col, font=font_caption)
        draw.text((nx+30, iy+8), label, fill=col if active else hex_to_rgb(TEXT2), font=font_body_sm)
        if active:
            draw.text((nx+nav_w-28, iy+8), "›", fill=col, font=font_caption)
        iy += 36

    # main cards scroll
    mx = nx+nav_w+12
    my = ny
    # card 1: ИИ и провайдеры
    rounded_rect(draw, (mx, my, mx+main_w, my+130), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
    draw.text((mx+16, my+14), "ИИ и провайдеры", fill=hex_to_rgb(TEXT1), font=font_section)
    draw.text((mx+16, my+34), "Модели показываются как «Быстрая» и «Умная»", fill=hex_to_rgb(TEXT2), font=font_meta)
    # rows
    # row1: Модель
    draw.text((mx+16, my+62), "Модель", fill=hex_to_rgb(TEXT1), font=font_body_sm)
    draw.text((mx+16, my+78), "Выбор модели для чата", fill=hex_to_rgb(TEXT2), font=font_meta)
    rounded_rect(draw, (mx+main_w-180, my+62, mx+main_w-16, my+88), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((mx+main_w-170, my+70), "Умная", fill=hex_to_rgb(TEXT1), font=font_body_sm)
    draw.text((mx+main_w-40, my+70), "▾", fill=hex_to_rgb(TEXT3), font=font_caption)
    # row2: Мышление
    draw.text((mx+16, my+100), "Мышление", fill=hex_to_rgb(TEXT1), font=font_body_sm)
    draw.text((mx+16, my+116), "Авто выбор глубины рассуждения", fill=hex_to_rgb(TEXT2), font=font_meta)
    rounded_rect(draw, (mx+main_w-180, my+100, mx+main_w-16, my+126), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((mx+main_w-170, my+108), "Авто", fill=hex_to_rgb(TEXT1), font=font_body_sm)
    draw.text((mx+main_w-40, my+108), "▾", fill=hex_to_rgb(TEXT3), font=font_caption)

    # card 2: Голос
    y2 = my+144
    rounded_rect(draw, (mx, y2, mx+main_w, y2+110), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
    draw.text((mx+16, y2+14), "Голос", fill=hex_to_rgb(TEXT1), font=font_section)
    # volume slider
    draw.text((mx+16, y2+42), "Громкость", fill=hex_to_rgb(TEXT1), font=font_body_sm)
    # slider track
    sx, sy = mx+16, y2+62
    sw = 220
    rounded_rect(draw, (sx, sy, sx+sw, sy+4), 2, fill=hex_to_rgb(SURFACE3))
    # fill 70%
    rounded_rect(draw, (sx, sy, sx+int(sw*0.7), sy+4), 2, fill=hex_to_rgb(ACCENT))
    # thumb
    draw.ellipse((sx+int(sw*0.7)-6, sy-6, sx+int(sw*0.7)+6, sy+10), fill=hex_to_rgb(ACCENT), outline=hex_to_rgb("#FFFFFF"), width=1)
    draw.text((sx+sw+10, sy-6), "70%", fill=hex_to_rgb(TEXT2), font=font_meta)
    # persona
    draw.text((mx+main_w-180, y2+42), "Характер", fill=hex_to_rgb(TEXT2), font=font_meta)
    rounded_rect(draw, (mx+main_w-180, y2+58, mx+main_w-16, y2+84), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((mx+main_w-170, y2+66), "Дворецкий", fill=hex_to_rgb(TEXT1), font=font_body_sm)
    draw.text((mx+main_w-40, y2+66), "▾", fill=hex_to_rgb(TEXT3), font=font_caption)

    # card 3: Внешний вид
    y3 = y2+124
    rounded_rect(draw, (mx, y3, mx+main_w, y3+92), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
    draw.text((mx+16, y3+14), "Внешний вид", fill=hex_to_rgb(TEXT1), font=font_section)
    draw.text((mx+16, y3+34), "Тема, акцент и плотность", fill=hex_to_rgb(TEXT2), font=font_meta)
    # accent circles
    ax = mx+16
    ay = y3+56
    for i, col in enumerate([ACCENT, "#8B5CF6", "#10B981", "#EC4899", "#F59E0B", "#06B6D4", "#E5E7EB"]):
        # circle
        draw.ellipse((ax+i*28, ay, ax+i*28+20, ay+20), fill=hex_to_rgb(col), outline=hex_to_rgb(BORDER) if col!="#E5E7EB" else hex_to_rgb(BORDER))
        if i==0:
            draw.ellipse((ax+i*28-2, ay-2, ax+i*28+22, ay+22), fill=None, outline=hex_to_rgb(ACCENT), width=2)
    # HEX input
    rounded_rect(draw, (mx+main_w-140, ay+2, mx+main_w-16, ay+22), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((mx+main_w-130, ay+6), "#2E9AC1", fill=hex_to_rgb(TEXT2), font=font_mono_sm)

    # card 4: Сфера Nox (future) — highlight
    y4 = y3+106
    # with preview 256x? Actually card 828 split: 560 + 256
    rounded_rect(draw, (mx, y4, mx+main_w, y4+164), 12, fill=hex_to_rgb(SURFACE1), outline=hex_to_rgb(BORDER))
    # badge Скоро
    rounded_rect(draw, (mx+16, y4+14, mx+96, y4+28), 6, fill=hex_to_rgb("#1E3340"), outline=hex_to_rgb(ACCENT))
    draw.text((mx+22, y4+16), "СКОРО", fill=hex_to_rgb(ACCENT), font=font_caption)
    draw.text((mx+106, y4+16), "Сфера Nox — preview only", fill=hex_to_rgb(TEXT1), font=font_section)
    draw.text((mx+16, y4+34), "Настройки применяются только к превью", fill=hex_to_rgb(TEXT2), font=font_meta)
    # segments
    rounded_rect(draw, (mx+16, y4+54, mx+116, y4+76), 12, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((mx+28, y4+60), "Wire", fill=hex_to_rgb(TEXT3), font=font_caption)
    rounded_rect(draw, (mx+116, y4+54, mx+220, y4+76), 12, fill=hex_to_rgb(ACCENT_SOFT), outline=hex_to_rgb(ACCENT))
    draw.text((mx+138, y4+60), "Nox Points ●", fill=hex_to_rgb(ACCENT), font=font_caption)
    # sliders
    draw.text((mx+16, y4+90), "Размер", fill=hex_to_rgb(TEXT1), font=font_body_sm)
    draw.text((mx+16, y4+106), "100%  →  70–120%", fill=hex_to_rgb(TEXT2), font=font_meta)
    # slider 1
    sx, sy = mx+16, y4+124
    sw = 160
    rounded_rect(draw, (sx, sy, sx+sw, sy+4), 2, fill=hex_to_rgb(SURFACE3))
    rounded_rect(draw, (sx, sy, sx+int(sw*0.5), sy+4), 2, fill=hex_to_rgb(ACCENT))
    draw.ellipse((sx+int(sw*0.5)-6, sy-6, sx+int(sw*0.5)+6, sy+10), fill=hex_to_rgb(ACCENT))
    draw.text((sx+sw+8, sy-6), "100%", fill=hex_to_rgb(TEXT2), font=font_meta)
    # second slider
    draw.text((mx+220, y4+90), "Свечение", fill=hex_to_rgb(TEXT1), font=font_body_sm)
    sx2, sy2 = mx+220, y4+124
    rounded_rect(draw, (sx2, sy2, sx2+sw, sy2+4), 2, fill=hex_to_rgb(SURFACE3))
    rounded_rect(draw, (sx2, sy2, sx2+int(sw*0.6), sy2+4), 2, fill=hex_to_rgb(ACCENT))
    draw.ellipse((sx2+int(sw*0.6)-6, sy2-6, sx2+int(sw*0.6)+6, sy2+10), fill=hex_to_rgb(ACCENT))
    draw.text((sx2+sw+8, sy2-6), "120%", fill=hex_to_rgb(TEXT2), font=font_meta)

    # preview canvas right
    px = mx+main_w-180
    py = y4+44
    rounded_rect(draw, (px, py, px+164, py+104), 12, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    # fake sphere
    # outer glow
    draw.ellipse((px+42, py+12, px+122, py+92), fill=hex_to_rgb("#1A3A4A"), outline=None)
    draw.ellipse((px+52, py+22, px+112, py+82), fill=hex_to_rgb("#0F2A36"), outline=hex_to_rgb(ACCENT))
    # dots
    for dx, dy in [(px+82, py+30), (px+92, py+42), (px+72, py+52), (px+88, py+62), (px+78, py+44)]:
        draw.ellipse((dx-2, dy-2, dx+2, dy+2), fill=hex_to_rgb(ACCENT))
    draw.text((px+52, py+88), "idle  ·  180 FPS", fill=hex_to_rgb(TEXT3), font=font_caption)
    # footer actions
    rounded_rect(draw, (mx+main_w-180, y4+136, mx+main_w-16, y4+158), 8, fill=hex_to_rgb(SURFACE2), outline=hex_to_rgb(BORDER))
    draw.text((mx+main_w-168, y4+142), "Сбросить", fill=hex_to_rgb(TEXT2), font=font_caption)
    rounded_rect(draw, (mx+main_w-88, y4+136, mx+main_w-16, y4+158), 8, fill=hex_to_rgb(ACCENT))
    draw.text((mx+main_w-76, y4+142), "Применить", fill=hex_to_rgb("#061217"), font=font_caption)

    img.save(f"{OUT}/04-settings.png", "PNG")
    print("saved 04")

if __name__ == "__main__":
    make_commands()
    make_editor()
    make_connections()
    make_settings()
    print("All done")
