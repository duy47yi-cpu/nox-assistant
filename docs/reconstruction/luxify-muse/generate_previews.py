#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Nox R2 — Preview generator 1200x720 + sphere storyboard
Generates 6 PNG mockups + 2 storyboard images using Pillow only.
Run: python generate_previews.py
"""
import math
from PIL import Image, ImageDraw, ImageFont, ImageFilter
import os

OUT = os.path.dirname(os.path.abspath(__file__))
PREV = os.path.join(OUT, "previews")
STORY = os.path.join(OUT, "storyboards")
os.makedirs(PREV, exist_ok=True)
os.makedirs(STORY, exist_ok=True)

W, H = 1200, 720

# Colors — dark theme Nox
C_BG = "#0F0F10"
C_SURFACE_RAIL = "#18181B"
C_SURFACE = "#18181B"
C_SURFACE2 = "#1C1C1F"
C_SURFACE3 = "#232326"
C_BORDER = "#2A2A2E"
C_BORDER_STRONG = "#34343A"
C_TEXT1 = "#F1F1F3"
C_TEXT2 = "#9A9AA0"
C_TEXT3 = "#6B6B70"
C_TEXT_GHOST = "#3A3A3E"
C_ACCENT = "#2E9AC1"
C_ACCENT_SOFT = "#1E3A47"  # approx 14% mix
C_ACCENT_HOVER = "#3AAAD6"
C_OK = "#3DD68C"
C_WARN = "#F5A524"
C_ERR = "#FF5C5C"

# Light theme
L_BG = "#F4F1EB"
L_SURFACE = "#FFFDF9"
L_SURFACE2 = "#EFEBE3"
L_SURFACE3 = "#E4DED3"
L_BORDER = "#D9D1C3"
L_BORDER_STRONG = "#C8BFB0"
L_TEXT1 = "#17140F"
L_TEXT2 = "#4B4439"
L_TEXT3 = "#8A857E"
L_ACCENT = "#2F5FD0"

def load_font(size, bold=False):
    # Try to load Inter or Segoe, fallback to default
    candidates = [
        "C:/Windows/Fonts/SegoeUI.ttf",
        "C:/Windows/Fonts/segoe-ui.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/Inter-Variable.ttf",
    ]
    bold_candidates = [
        "C:/Windows/Fonts/SegoeUI-Bold.ttf",
        "C:/Windows/Fonts/segoeuib.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
    ]
    lst = bold_candidates if bold else candidates
    for p in lst:
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except: pass
    # fallback
    try:
        return ImageFont.truetype("arial.ttf", size)
    except:
        return ImageFont.load_default()

F8 = load_font(8)
F10 = load_font(10)
F11 = load_font(11)
F12 = load_font(12)
F13 = load_font(13)
F14 = load_font(14)
F16 = load_font(16)
F16B = load_font(16, bold=True)
F18B = load_font(18, bold=True)
F20B = load_font(20, bold=True)
F22B = load_font(22, bold=True)
F11B = load_font(11, bold=True)
F12B = load_font(12, bold=True)
F13B = load_font(13, bold=True)

def hex_to_rgb(h):
    h=h.lstrip("#")
    return tuple(int(h[i:i+2],16) for i in (0,2,4))

def rounded_rect(draw, xy, r, fill=None, outline=None, width=1):
    x0,y0,x1,y1 = xy
    draw.rounded_rectangle(xy, radius=r, fill=fill, outline=outline, width=width)

def draw_sphere_wire(draw, cx, cy, R, accent="#2E9AC1", state="idle", voice=0):
    """Draw wire sphere approximating Nox wire variant"""
    rgb = hex_to_rgb(accent)
    # glow behind
    for i in range(6):
        rr = R + 12 + i*4
        a = int(22 - i*3)
        draw.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], fill=None, outline=(*rgb, a) if len(rgb)==3 else rgb, width=1)
    # meridians
    meridians = 24
    for m in range(meridians):
        theta = m * math.pi / meridians
        pts=[]
        for j in range(64):
            phi = j * math.pi / 63 - math.pi/2
            # deform
            deform = 0
            if state in ("thinking","executing"):
                deform = math.sin(phi*3 + theta*2)*0.06
            elif state=="listening":
                deform = voice*0.04*math.sin(phi*8)
            elif state=="idle":
                deform = 0.025*math.sin(theta)
            r = R*(1+deform)
            x = cx + r*math.cos(phi)*math.cos(theta)
            y = cy + r*math.sin(phi)*0.92  # slight ellipse
            # depth via theta: front brighter
            depth = (math.cos(theta)+1)/2  # 0..1
            if j==0: prev=(x,y)
            else:
                # only draw front half more opaque
                alpha = int(60 + depth*140)
                if j%2==0:
                    draw.line([prev,(x,y)], fill=(*rgb, alpha) if draw.im else rgb, width=1)
                prev=(x,y)
        # skip
    # parallels
    for p in range(-8,9):
        phi = p * math.pi/18
        rr = R*math.cos(phi)*0.96
        y = cy + R*math.sin(phi)*0.9
        if rr<4: continue
        # ellipse for parallel
        # split front/back
        # front arc brighter
        try:
            draw.ellipse([cx-rr, y-1, cx+rr, y+1], outline=rgb, width=1)
        except: pass
    # belt
    belt_y = cy + R*0.12
    belt_r = R*0.88
    belt_color = rgb
    if state=="waiting":
        belt_color = hex_to_rgb(C_WARN)
    elif state=="error":
        belt_color = hex_to_rgb(C_ERR)
    elif state=="success":
        belt_color = hex_to_rgb(C_OK)
    draw.ellipse([cx-belt_r, belt_y-2, cx+belt_r, belt_y+2], outline=belt_color, width=2)
    # core glow
    for rr,a in [(22,60),(16,90),(10,140)]:
        draw.ellipse([cx-rr, cy-rr+4, cx+rr, cy+rr+4], fill=None, outline=(*rgb[:3], a) if len(rgb)==3 else rgb, width=1)

def draw_sphere_dots(draw, cx, cy, R, accent="#2E9AC1", state="idle", light_bg=False):
    """Draw dot sphere (Nox variant) — Fibonacci points with lighting"""
    rgb = hex_to_rgb(accent)
    if state=="waiting":
        rgb = hex_to_rgb(C_WARN)
    elif state=="error":
        rgb = hex_to_rgb(C_ERR)
    elif state=="success":
        rgb = hex_to_rgb(C_OK)
    # halo
    for rr,a in [(R+20, 12),(R+12,18),(R+6,24)]:
        c = (*rgb, a)
        try:
            draw.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], outline=c, width=1)
        except:
            draw.ellipse([cx-rr, cy-rr, cx+rr, cy+rr], outline=rgb, width=1)
    # points
    N=420  # reduced for perf
    GOLDEN = math.pi*(3-math.sqrt(5))
    for i in range(N):
        y = 1 - (i / (N-1))*2  # -1..1
        r_at = math.sqrt(max(0,1-y*y))
        theta = i*GOLDEN
        # 3D position
        x3 = math.cos(theta)*r_at
        y3 = y
        z3 = math.sin(theta)*r_at
        # apply tilt 0.13 rad around X
        tilt=0.13
        y3t = y3*math.cos(tilt) - z3*math.sin(tilt)
        z3t = y3*math.sin(tilt) + z3*math.cos(tilt)
        x3t = x3
        # breathing deform
        deform = 0
        if state=="idle":
            deform = 0.035*math.sin(theta*2)
        elif state=="thinking":
            deform = 0.07*math.sin(theta*3 + i*0.1)
        elif state=="listening":
            deform = 0.05*math.sin(theta*4)
        scale = 1+deform
        x3t*=scale; y3t*=scale
        # project orthographic
        px = cx + x3t*R
        py = cy + y3t*R*0.92
        # lighting: key light -0.55,0.72,0.42
        nx, ny, nz = x3t, y3t, z3t
        # normalize
        d = math.hypot(nx,ny,nz) or 1
        nx/=d; ny/=d; nz/=d
        key = max(0, nx*(-0.55)+ny*0.72+nz*0.42)
        rim = max(0, nx*0.52+ny*(-0.44)+nz*0.30)
        bright = 0.25 + key*0.75 + rim*0.25
        if z3t < -0.15: bright *= 0.45  # back side dim
        if bright<0.12: continue
        sz = 1 if bright<0.35 else (1.5 if bright<0.6 else 2)
        alpha = int(bright*190 + 40)
        # color blend: mix accent with white by bright
        rC = int(rgb[0]*(0.6+bright*0.4) + 255*bright*0.15)
        gC = int(rgb[1]*(0.6+bright*0.4) + 255*bright*0.15)
        bC = int(rgb[2]*(0.6+bright*0.4) + 255*bright*0.15)
        rC = min(255,max(0,rC)); gC=min(255,max(0,gC)); bC=min(255,max(0,bC))
        if sz<=1:
            draw.point((px,py), fill=(rC,gC,bC))
        else:
            draw.ellipse([px-sz, py-sz, px+sz, py+sz], fill=(rC,gC,bC))
    # core
    coreR = R*0.38
    for rr,a in [(coreR, 40),(coreR*0.7,70),(coreR*0.4,110)]:
        try:
            draw.ellipse([cx-rr, cy-rr+2, cx+rr, cy+rr+2], fill=(rgb[0],rgb[1],rgb[2],a), outline=None)
        except:
            draw.ellipse([cx-rr, cy-rr+2, cx+rr, cy+rr+2], fill=rgb)

def panel(base_draw, x,y,w,h, fill=C_SURFACE, border=C_BORDER, radius=16):
    rounded_rect(base_draw, (x,y,x+w,y+h), radius, fill=fill, outline=border, width=1)

def text_in(draw, x,y, txt, font=F13, color=C_TEXT1, max_w=None, anchor="lt"):
    # simple wrap by words if max_w
    if max_w:
        words = txt.split(" ")
        line=""
        lines=[]
        for wrd in words:
            test = (line+" "+wrd).strip()
            bbox = draw.textbbox((0,0), test, font=font)
            if bbox[2]-bbox[0] > max_w and line:
                lines.append(line)
                line=wrd
            else:
                line=test
        lines.append(line)
        for i,l in enumerate(lines):
            draw.text((x, y+i*(font.size+4 if hasattr(font,"size") else 16)), l, font=font, fill=color, anchor=anchor)
        return len(lines)*(font.size+4 if hasattr(font,"size") else 16)
    else:
        draw.text((x,y), txt, font=font, fill=color, anchor=anchor)
        bbox = draw.textbbox((0,0), txt, font=font)
        return bbox[3]-bbox[1]

def create_base(theme="dark"):
    if theme=="dark":
        bg=C_BG
        surf=C_SURFACE
        surf2=C_SURFACE2
        surf3=C_SURFACE3
        border=C_BORDER
        borderS=C_BORDER_STRONG
        t1=C_TEXT1; t2=C_TEXT2; t3=C_TEXT3; ghost=C_TEXT_GHOST
        accent=C_ACCENT
    else:
        bg=L_BG
        surf=L_SURFACE
        surf2=L_SURFACE2
        surf3=L_SURFACE3
        border=L_BORDER
        borderS=L_BORDER_STRONG
        t1=L_TEXT1; t2=L_TEXT2; t3=L_TEXT3; ghost="#CFCAC0"
        accent=L_ACCENT
    img = Image.new("RGBA", (W,H), bg)
    d = ImageDraw.Draw(img, "RGBA")
    # window border 12 radius outer is bg, inner panels
    # draw app container with border 1px and radius 12
    # Actually we draw gap 8 around
    pad=8
    # app bg is same as bg but we draw border
    # grid panels
    rail_w=52
    hist_w=244
    sphere_w=360
    gap=8
    # rail
    rx, ry = pad, pad
    rh = H - pad*2
    panel(d, rx, ry, rail_w, rh, fill=surf, border=border, radius=16)
    # adjust to have left-rounded only? we do full but history will overlap gap
    # history
    hx = rx + rail_w  # no gap, as per design
    # actually history has no left border, radius 0 16 16 0
    # we simulate by drawing history overlapping rail border
    hx = rx+rail_w
    hw = hist_w
    # draw history panel with custom radius
    rounded_rect(d, (hx, ry, hx+hw, ry+rh), 16, fill=surf, outline=border, width=1)
    # cover left edge to make joint
    d.rectangle([hx-1, ry+8, hx+2, ry+rh-8], fill=surf)
    # chat
    cx = hx+hw+gap
    cw = W - cx - sphere_w - gap - pad
    panel(d, cx, ry, cw, rh, fill=surf, border=border, radius=16)
    # sphere
    sx = W - pad - sphere_w
    panel(d, sx, ry, sphere_w, rh, fill=surf, border=border, radius=16)
    return img, d, dict(bg=bg, surf=surf, surf2=surf2, surf3=surf3, border=border, borderS=borderS, t1=t1, t2=t2, t3=t3, ghost=ghost, accent=accent), (rx,ry,rail_w,rh, hx,hw, cx,cw, sx,sphere_w)

def draw_rail(d, rx,ry,rw,rh, theme, active="Главная"):
    cols = dict(
        dark=dict(t1=C_TEXT1, t2=C_TEXT2, t3=C_TEXT3, accent=C_ACCENT, border=C_BORDER, soft=C_ACCENT_SOFT),
        light=dict(t1=L_TEXT1, t2=L_TEXT2, t3=L_TEXT3, accent=L_ACCENT, border=L_BORDER, soft="#DCE6FF")
    )[theme]
    # brand mark top
    # circle with notch
    cx = rx+rw//2
    cy = ry+18+16
    # mark: circle border 1.6px
    d.ellipse([cx-9, cy-9, cx+9, cy+9], outline=cols["t1"], width=2)
    # small notch circle cutout
    d.ellipse([cx+4, cy-7, cx+12, cy+1], fill=cols["t1"] if theme=="dark" else cols["t1"], outline=None)
    # Actually do bg cutout
    bgcol = C_SURFACE if theme=="dark" else L_SURFACE
    d.ellipse([cx+5, cy-6, cx+11, cy+0], fill=bgcol)
    # nav items
    icons = ["⌂","▦","◈","⚙","◉"]
    labels = ["Главная","Команды","Подключения","Настройки","Журнал"]
    y = ry+62
    for i, lab in enumerate(labels):
        is_active = lab==active
        ix = rx+8
        iy = y+i*40
        if is_active:
            # bg soft
            rounded_rect(d, (ix, iy, ix+rw-16, iy+36), 10, fill=cols["soft"], outline=None)
            # left bar 4x22
            d.rounded_rectangle((rx-1, iy+7, rx+3, iy+29), radius=2, fill=cols["accent"])
            col = cols["accent"]
        else:
            col = cols["t3"]
        # icon: simple square 18px
        icon_x = ix+9
        icon_y = iy+9
        # draw icon as rounded square with glyph
        d.rounded_rectangle((icon_x, icon_y, icon_x+18, icon_y+18), radius=4, fill=None, outline=col, width=1)
        # inner glyph dot
        if lab=="Главная": d.ellipse([icon_x+6, icon_y+5, icon_x+12, icon_y+11], fill=col)
        elif lab=="Команды": 
            for k in range(3):
                d.rectangle([icon_x+4, icon_y+5+k*4, icon_x+14, icon_y+6+k*4], fill=col)
        elif lab=="Подключения": d.ellipse([icon_x+5, icon_y+5, icon_x+13, icon_y+13], outline=col, width=1)
        elif lab=="Настройки": d.ellipse([icon_x+4, icon_y+4, icon_x+14, icon_y+14], outline=col, width=1)
        elif lab=="Журнал": 
            for k in range(3): d.rectangle([icon_x+4, icon_y+5+k*4, icon_x+14, icon_y+6+k*4], fill=col)
    # bottom account
    ay = ry+rh-44
    d.ellipse([cx-16, ay, cx+16, ay+32], outline=cols["border"], width=1)
    d.text((cx, ay+16), "AK", font=F11, fill=cols["t2"], anchor="mm")
    # collapse hidden
    return y

def draw_history(d, hx,ry,hw,rh, theme, empty=False):
    col = dict(dark=dict(t1=C_TEXT1, t2=C_TEXT2, t3=C_TEXT3, border=C_BORDER), light=dict(t1=L_TEXT1, t2=L_TEXT2, t3=L_TEXT3, border=L_BORDER))[theme]
    # header
    tx = hx+12
    ty = ry+14
    d.text((tx, ty), "История", font=F16B, fill=col["t1"])
    # new chat button
    btn_y = ty+26
    rounded_rect(d, (tx, btn_y, tx+hw-24, btn_y+32), 99, fill=col["border"] if theme=="dark" else "#E4DED3", outline=col["border"], width=1)
    d.text((tx+12, btn_y+16), "+  Новый чат", font=F12, fill=col["t2"], anchor="lm")
    # sections
    sy = btn_y+48
    if empty:
        d.text((tx, sy), "Чатов пока нет", font=F12, fill=col["t3"])
        d.text((tx, sy+18), "Начните диалог, чтобы", font=F11, fill=col["t3"])
        d.text((tx, sy+30), "увидеть историю здесь", font=F11, fill=col["t3"])
        return
    d.text((tx, sy), "СЕГОДНЯ", font=F11, fill=col["t3"])
    sy+=16
    chats = [
        ("Разобрать почту и ответить", True),
        ("План презентации Nox", False),
        ("Будильник на 7:30", False),
        ("Исправить баг авторизации", False),
    ]
    for title, active in chats:
        if active:
            rounded_rect(d, (tx, sy, tx+hw-24, sy+36), 10, fill="#1E2E3A" if theme=="dark" else "#E8EEFF", outline="#2E9AC1" if theme=="dark" else "#2F5FD0", width=1 if active else 0)
            # Actually active style: 9% white + border 7%
            # we do subtle
        else:
            # hover none
            pass
        # text
        d.text((tx+8, sy+18), title[:26], font=F12, fill=col["t1"] if active else col["t2"], anchor="lm")
        # more
        d.text((tx+hw-32, sy+18), "…", font=F12, fill=col["t3"], anchor="mm")
        sy+=40
    d.text((tx, sy+8), "РАНЕЕ", font=F11, fill=col["t3"])
    sy+=20
    earlier = ["Настроить тему Nox", "Команда для Spotify", "Проверить доступность API"]
    for title in earlier:
        d.text((tx+8, sy+10), title[:27], font=F12, fill=col["t2"])
        sy+=22
    # workspace switch bottom
    wy = ry+rh-38
    d.line([(hx+12, wy), (hx+hw-12, wy)], fill=col["border"], width=1)
    d.text((tx, wy+12), "Пространство:", font=F11, fill=col["t3"])
    rounded_rect(d, (tx+80, wy+6, tx+hw-16, wy+22), 8, fill=col["border"], outline=col["border"], width=1)
    d.text((tx+86, wy+14), "Общее  ▾", font=F11, fill=col["t2"], anchor="lm")

def draw_chat_header(d, cx,ry,cw, theme, title_only=False):
    # header bar 44px with icon row
    col=dict(dark=dict(t1=C_TEXT1, t3=C_TEXT3, border=C_BORDER), light=dict(t1=L_TEXT1, t3=L_TEXT3, border=L_BORDER))[theme]
    # we draw header line
    hy=cx  # not needed
    # title already if empty
    pass

# ---------- MOCKUP 1: Main + Sphere idle ----------
def mockup_main():
    img,d,c, (rx,ry,rw,rh, hx,hw, cx,cw, sx,sw) = create_base("dark")
    draw_rail(d, rx,ry,rw,rh, "dark", "Главная")
    draw_history(d, hx,ry,hw,rh, "dark")
    # chat
    # header NOX word hidden when not empty? but we show chat content
    # chat feed
    # padding 20
    chat_x = cx+20
    chat_y = ry+16
    chat_w = cw-40
    # top small meta
    d.text((chat_x, chat_y), "Сегодня  •  14:32", font=F11, fill=c["t3"])
    chat_y+=18
    # user bubble
    ux = chat_x+40
    uw = chat_w-80
    # user bubble right aligned? we do left for simplicity but right bubble
    # user row
    bubble_w = 340
    bx = chat_x+chat_w - bubble_w - 8
    by = chat_y
    rounded_rect(d, (bx, by, bx+bubble_w, by+44), 12, fill=c["surf3"], outline=c["border"], width=1)
    d.text((bx+12, by+10), "Привет, Nox. Что у нас на сегодня?", font=F13, fill=c["t1"])
    d.text((bx+12, by+26), "10:14", font=F10, fill=c["t3"])
    chat_y = by+60
    # assistant turn
    d.text((chat_x, chat_y), "NOX", font=F11B, fill=c["t3"])
    chat_y+=14
    # assistant message card
    # wrap text
    msg = "Доброе утро! На сегодня — 3 задачи, 1 напоминание и 2 открытых поручения. Хочешь разобрать почту или перейти к проекту Nox?"
    # draw background for md? Actually turn is without bubble but we draw subtle guide
    # we draw msg lines
    lines = ["Доброе утро! На сегодня — 3 задачи,", "1 напоминание и 2 открытых поручения.", "Хочешь разобрать почту или перейти", "к проекту Nox?"]
    for l in lines:
        d.text((chat_x, chat_y), l, font=F13, fill=c["t1"])
        chat_y+=18
    chat_y+=10
    # suggestion chips
    chip_x=chat_x
    for chip in ["Разобрать почту", "Открыть Nox Release", "Показать календарь"]:
        tw = d.textbbox((0,0), chip, font=F12)[2]+24
        rounded_rect(d, (chip_x, chat_y, chip_x+tw, chat_y+28), 99, fill=c["surf2"], outline=c["border"], width=1)
        d.text((chip_x+12, chat_y+14), chip, font=F12, fill=c["t2"], anchor="lm")
        chip_x+=tw+8
    chat_y+=40
    # copy button under turn
    rounded_rect(d, (chat_x, chat_y, chat_x+40, chat_y+22), 7, fill=None, outline=c["border"], width=1)
    d.text((chat_x+20, chat_y+11), "⎘", font=F11, fill=c["t3"], anchor="mm")
    chat_y+=30
    # composer capsule
    comp_y = ry+rh - 62
    comp_x = cx+12
    comp_w = cw-24
    comp_h = 50
    rounded_rect(d, (comp_x, comp_y, comp_x+comp_w, comp_y+comp_h), 16, fill=c["surf2"], outline=c["border"], width=1)
    # input placeholder
    d.text((comp_x+14, comp_y+14), "Спроси Nox или дай поручение…", font=F13, fill=c["t3"])
    # bottom row icons
    # attach, region on left
    icon_y = comp_y+34
    d.text((comp_x+14, icon_y), "📎", font=F12, fill=c["t3"], anchor="lm")
    d.text((comp_x+38, icon_y), "◫", font=F12, fill=c["t3"], anchor="lm")
    # picks pill center-right
    pill = "Быстрая  •  Подумать"
    tw = d.textbbox((0,0), pill, font=F11)[2]+20
    px = comp_x+comp_w - 160 - tw
    rounded_rect(d, (px, icon_y-11, px+tw, icon_y+11), 99, fill=c["surf3"], outline=c["border"], width=1)
    d.text((px+10, icon_y), pill, font=F11, fill=c["t2"], anchor="lm")
    # mic
    mx = comp_x+comp_w - 64
    d.ellipse([mx, icon_y-14, mx+28, icon_y+14], fill=c["surf3"], outline=c["border"], width=1)
    d.text((mx+14, icon_y), "◉", font=F11, fill=c["t2"], anchor="mm")
    # send accent
    sxb = comp_x+comp_w - 30
    d.ellipse([sxb, icon_y-14, sxb+28, icon_y+14], fill=c["accent"], outline=c["accent"], width=1)
    d.text((sxb+14, icon_y), "↑", font=F12B, fill="#FFFFFF", anchor="mm")
    # sphere panel header
    d.text((sx+sw-44, ry+14), "—  □  ✕", font=F11, fill=c["t3"])
    # sphere
    sphere_cx = sx+sw//2
    sphere_cy = ry+rh//2 - 8
    R=112
    draw_sphere_dots(d, sphere_cx, sphere_cy, R, accent=C_ACCENT, state="idle")
    # state label under sphere
    d.text((sphere_cx, sphere_cy+R+28), "Сфера • покой • 2.1с", font=F11, fill=c["t3"], anchor="mm")
    d.text((sphere_cx, sphere_cy+R+42), "Акцент следует теме — #2E9AC1", font=F11, fill=c["t2"], anchor="mm")
    # window controls hint
    # bottom hint
    d.text((sphere_cx, ry+rh-18), "Наведи — дыхание глубже • Клик — внимательность", font=F11, fill=c["t3"], anchor="mm")
    img.save(os.path.join(PREV, "01-main.png"))
    print("01-main ok")

# ---------- MOCKUP 2: Agent doing task ----------
def mockup_agent():
    img,d,c, (rx,ry,rw,rh, hx,hw, cx,cw, sx,sw) = create_base("dark")
    draw_rail(d, rx,ry,rw,rh, "dark", "Главная")
    draw_history(d, hx,ry,hw,rh, "dark")
    chat_x=cx+20
    chat_w=cw-40
    y=ry+16
    d.text((chat_x, y), "Сегодня  •  14:32", font=F11, fill=c["t3"])
    y+=18
    # user request
    bw=380
    bx=chat_x+chat_w-bw-8
    rounded_rect(d, (bx, y, bx+bw, y+36), 12, fill=c["surf3"], outline=c["border"], width=1)
    d.text((bx+12, y+12), "Открой почту и разбери важное за сегодня", font=F13, fill=c["t1"])
    y+=52
    # agent card
    card_x=chat_x
    card_w=chat_w
    card_y=y
    card_h=168
    rounded_rect(d, (card_x, card_y, card_x+card_w, card_y+card_h), 16, fill=c["surf2"], outline=c["border"], width=1)
    # header
    # status dot blue + Agent Nox + Step 2/4 + Stop
    d.ellipse([card_x+14, card_y+12, card_x+22, card_y+20], fill=C_ACCENT)
    d.text((card_x+28, card_y+16), "Агент Nox", font=F12B, fill=c["t1"])
    d.text((card_x+110, card_y+16), "Шаг 2 из 4", font=F11, fill=c["t2"])
    # Stop button
    stop_x=card_x+card_w-62
    rounded_rect(d, (stop_x, card_y+8, stop_x+52, card_y+28), 8, fill=c["surf3"], outline=c["border"], width=1)
    d.text((stop_x+26, card_y+18), "■ Стоп", font=F11, fill=c["t1"], anchor="mm")
    # divider
    d.line([(card_x+14, card_y+32), (card_x+card_w-14, card_y+32)], fill=c["border"], width=1)
    # action
    d.text((card_x+14, card_y+48), "●", font=F12, fill=C_ACCENT)
    d.text((card_x+30, card_y+48), "Нажимаю «Написать» в Почта", font=F13, fill=c["t1"])
    d.text((card_x+14, card_y+66), "Цель подсвечена синей обводкой — проверь, если нужно", font=F11, fill=c["t3"])
    # approval block revealed
    # inner divider
    d.line([(card_x+14, card_y+82), (card_x+card_w-14, card_y+82)], fill=c["border"], width=1)
    d.text((card_x+14, card_y+94), "Жду вашего разрешения", font=F12B, fill=C_WARN)
    d.text((card_x+14, card_y+110), "Нажать «Отправить» в Почта?  Будет отправлено: «Привет, Маша! Опоздаю на 10м»", font=F11, fill=c["t2"])
    # buttons
    rounded_rect(d, (card_x+14, card_y+128, card_x+110, card_y+152), 8, fill=None, outline=c["border"], width=1)
    d.text((card_x+62, card_y+140), "Отклонить", font=F12, fill=c["t2"], anchor="mm")
    rounded_rect(d, (card_x+118, card_y+128, card_x+214, card_y+152), 8, fill=C_ACCENT, outline=C_ACCENT, width=1)
    d.text((card_x+166, card_y+140), "Разрешить →", font=F12B, fill="#FFFFFF", anchor="mm")
    d.text((card_x+card_w-48, card_y+140), "30с", font=F11, fill=c["t3"], anchor="mm")
    y=card_y+card_h+14
    # step chips in chat
    for chip in ["✓ Открыть Почта — выполнено", "○ Прочитать письма — не проверено", "⏳ Написать — жду разрешения"]:
        tw = d.textbbox((0,0), chip, font=F11)[2]+20
        cx_chip = chat_x + (chat_w-tw)//2
        col = c["surf2"]
        # success chip slightly green border
        border = C_OK if "выполнено" in chip else c["border"]
        rounded_rect(d, (cx_chip, y, cx_chip+tw, y+22), 99, fill=col, outline=border, width=1)
        fill = C_OK if "выполнено" in chip else c["t2"]
        d.text((cx_chip+10, y+11), chip, font=F11, fill=fill, anchor="lm")
        y+=28
    # composer same as before but with working indicator
    d.text((chat_x, y+6), "▸ Ход работы  00:08", font=F11, fill=c["t2"])
    # sphere thinking
    d.text((sx+sw-44, ry+14), "—  □  ✕", font=F11, fill=c["t3"])
    sphere_cx=sx+sw//2
    sphere_cy=ry+rh//2 -8
    R=112
    draw_sphere_dots(d, sphere_cx, sphere_cy, R, accent=C_ACCENT, state="thinking")
    d.text((sphere_cx, sphere_cy+R+28), "Думаю • 0.9с • ярче + ореол", font=F11, fill=c["t3"], anchor="mm")
    d.text((sphere_cx, sphere_cy+R+42), "Пояс бежит — ищу цель клика", font=F11, fill=c["t2"], anchor="mm")
    img.save(os.path.join(PREV, "02-agent.png"))
    print("02-agent ok")

# ---------- MOCKUP 3: Voice ----------
def mockup_voice():
    img,d,c, (rx,ry,rw,rh, hx,hw, cx,cw, sx,sw) = create_base("dark")
    draw_rail(d, rx,ry,rw,rh, "dark", "Главная")
    draw_history(d, hx,ry,hw,rh, "dark")
    chat_x=cx+20
    chat_w=cw-40
    y=ry+16
    d.text((chat_x, y), "Сегодня  •  14:33  •  Голос", font=F11, fill=c["t3"])
    y+=18
    # user voice message as bubble with mic
    bw=360
    bx=chat_x+chat_w-bw-8
    rounded_rect(d, (bx, y, bx+bw, y+52), 12, fill=c["surf3"], outline=c["border"], width=1)
    d.text((bx+12, y+12), "🎤 «Джарвис, включи музыку»", font=F13, fill=c["t1"])
    d.text((bx+12, y+28), "Распознано • 14:33", font=F11, fill=c["t3"])
    y+=68
    # assistant answer with speaker icon
    d.text((chat_x, y), "NOX  🔊", font=F11B, fill=c["t3"])
    y+=14
    lines=["Включаю Spotify — плейлист «Работа».",
           "Громкость 35%."]
    for l in lines:
        d.text((chat_x, y), l, font=F13, fill=c["t1"])
        y+=18
    y+=8
    # small waveform + stop
    rounded_rect(d, (chat_x, y, chat_x+180, y+28), 8, fill=c["surf2"], outline=c["border"], width=1)
    # mini wave
    for i, h in enumerate([6,12,18,10,14]):
        d.rectangle([chat_x+12+i*8, y+14-h//2, chat_x+14+i*8, y+14+h//2], fill=C_ACCENT)
    d.text((chat_x+60, y+14), "Говорю…", font=F11, fill=c["t2"], anchor="lm")
    d.text((chat_x+130, y+14), "■ Стоп", font=F11, fill=c["t2"], anchor="lm")
    y+=40
    # live composer expanded
    comp_y = ry+rh - 88
    comp_x = cx+12
    comp_w = cw-24
    # listening capsule taller
    rounded_rect(d, (comp_x, comp_y, comp_x+comp_w, comp_y+76), 16, fill=c["surf2"], outline=C_ERR, width=1)
    # wake pill
    rounded_rect(d, (comp_x+12, comp_y+10, comp_x+84, comp_y+30), 99, fill=C_ACCENT, outline=C_ACCENT, width=1)
    d.text((comp_x+48, comp_y+20), "Джарвис", font=F11B, fill="#FFFFFF", anchor="mm")
    # live text
    d.text((comp_x+94, comp_y+20), "включи музыку", font=F13, fill=c["t1"], anchor="lm")
    d.text((comp_x+94+ d.textbbox((0,0), "включи музыку", font=F13)[2]+2, comp_y+20), "▐", font=F13, fill=C_ACCENT, anchor="lm")
    # wave 5 bars
    wx = comp_x+12
    wy = comp_y+48
    for i, h in enumerate([8,16,22,14,10]):
        col = C_ACCENT if i==2 else c["t3"]
        d.rounded_rectangle((wx+i*8, wy-h//2, wx+2+i*8, wy+h//2), radius=1, fill=col)
    d.text((wx+52, wy), "Слушаю…  •  interim  •  5–9 зн/с", font=F11, fill=c["t3"], anchor="lm")
    # mic red
    mx = comp_x+comp_w-64
    d.ellipse([mx, wy-14, mx+28, wy+14], fill="#3A1A1A", outline=C_ERR, width=1)
    d.text((mx+14, wy), "◉", font=F11, fill=C_ERR, anchor="mm")
    sxb = comp_x+comp_w-30
    d.ellipse([sxb, wy-14, sxb+28, wy+14], fill=c["accent"], outline=c["accent"], width=1)
    d.text((sxb+14, wy), "↑", font=F12B, fill="#FFFFFF", anchor="mm")
    # sphere listening
    d.text((sx+sw-44, ry+14), "—  □  ✕", font=F11, fill=c["t3"])
    sphere_cx=sx+sw//2
    sphere_cy=ry+rh//2 -8
    draw_sphere_dots(d, sphere_cx, sphere_cy, 118, accent=C_ACCENT, state="listening")
    d.text((sphere_cx, sphere_cy+132), "Слушаю • рябь + ядро пульсирует", font=F11, fill=c["t3"], anchor="mm")
    d.text((sphere_cx, sphere_cy+146), "setVoice(level) — 5 столбиков в такт", font=F11, fill=c["t2"], anchor="mm")
    img.save(os.path.join(PREV, "03-voice.png"))
    print("03-voice ok")

# ---------- MOCKUP 4: Commands ----------
def mockup_commands():
    img,d,c, (rx,ry,rw,rh, hx,hw, cx,cw, sx,sw) = create_base("dark")
    # For commands screen we reuse layout but split differently: rail + main area divided
    draw_rail(d, rx,ry,rw,rh, "dark", "Команды")
    # main area is commands catalog — we draw inside cx,cw but full height
    # we ignore history/sphere split for this mockup — show commands full
    # Actually we keep grid but hide sphere? For simplicity keep sphere as command detail? We'll draw commands layout inside chat panel
    # header
    d.text((cx+16, ry+14), "Команды", font=F16B, fill=c["t1"])
    d.text((cx+120, ry+16), "20 команд · 4 коллекции · выключено 3", font=F11, fill=c["t3"])
    # search + buttons
    search_w=180
    search_x=cx+cw - search_w -16
    rounded_rect(d, (search_x, ry+10, search_x+search_w, ry+34), 10, fill=c["surf3"], outline=c["border"], width=1)
    d.text((search_x+10, ry+22), "⌕  Поиск", font=F11, fill=c["t3"], anchor="lm")
    # new button
    btn_w=92
    btn_x=search_x - btn_w -8
    rounded_rect(d, (btn_x, ry+10, btn_x+btn_w, ry+34), 10, fill=c["accent"], outline=c["accent"], width=1)
    d.text((btn_x+46, ry+22), "+ Новая", font=F12B, fill="#FFFFFF", anchor="mm")
    # left tree
    tree_x=cx+16
    tree_y=ry+50
    tree_w=260
    tree_h=rh-76
    rounded_rect(d, (tree_x, tree_y, tree_x+tree_w, tree_y+tree_h), 12, fill=c["surf2"], outline=c["border"], width=1)
    d.text((tree_x+12, tree_y+16), "Дерево команд", font=F12B, fill=c["t1"])
    y=tree_y+32
    items = [
        ("Команды по умолчанию", 0, False, False),
        ("  Открытие сайтов", 1, False, False),
        ("  Открытие приложений",1, True, False),
        ("Мои команды",0, True, True),
        ("  Работа",1, False, False),
        ("    Включить музыку",2, False, True),
        ("    Тихий режим",2, False, False),
        ("  Личное",1, False, False),
    ]
    for title, lvl, expanded, active in items:
        x = tree_x+12+lvl*16
        bg = c["surf3"] if active else None
        if active:
            rounded_rect(d, (tree_x+8, y-6, tree_x+tree_w-8, y+16), 8, fill=c["accent"]+"22" if False else "#1E3340", outline=None)
            # use accent soft
            d.rounded_rectangle((tree_x+8, y-6, tree_x+tree_w-8, y+16), radius=8, fill="#1A2E3A")
        # chevron
        chev = "▾" if expanded else "▸" if lvl<2 else "·"
        d.text((x, y), chev, font=F11, fill=c["t3"])
        d.text((x+14, y), title.strip(), font=F12, fill=c["t1"] if active else c["t2"])
        if active:
            # 3 buttons on right
            bx = tree_x+tree_w-68
            for j, glyph in enumerate(["✎","⏻","🗑"]):
                rxb=bx+j*20
                d.rounded_rectangle((rxb, y-6, rxb+16, y+12), radius=4, fill=c["surf3"], outline=c["border"], width=1)
                d.text((rxb+8, y+3), glyph, font=F10, fill=c["t2"], anchor="mm")
        y+=22
        if y>tree_y+tree_h-20: break
    # center editor form
    form_x=tree_x+tree_w+12
    form_w=cw - (tree_w+40)
    form_y=tree_y
    form_h=tree_h
    rounded_rect(d, (form_x, form_y, form_x+form_w, form_y+form_h), 12, fill=c["surf2"], outline=c["border"], width=1)
    d.text((form_x+12, form_y+14), "Включить музыку", font=F13B, fill=c["t1"])
    d.text((form_x+form_w-80, form_y+14), "Отмена  Сохранить", font=F11, fill=c["t3"], anchor="lm")
    # save accent dot
    d.ellipse([form_x+form_w-16, form_y+8, form_x+form_w-8, form_y+16], fill=C_ACCENT)
    # fields
    fy=form_y+36
    # name field
    d.text((form_x+12, fy), "Название", font=F11, fill=c["t3"])
    fy+=14
    rounded_rect(d, (form_x+12, fy, form_x+form_w-12, fy+32), 8, fill=c["surf3"], outline=c["accent"], width=1)
    d.text((form_x+20, fy+16), "Включить музыку", font=F12, fill=c["t1"], anchor="lm")
    fy+=44
    # switches
    d.text((form_x+12, fy), "☐  Связывать", font=F11, fill=c["t2"])
    d.text((form_x+110, fy), "☑  Подтверждать", font=F11, fill=c["t2"])
    fy+=20
    # action buttons
    for i, lab in enumerate(["+ Действие", "⟐ Запись", "✦ Создать с ИИ"]):
        bx=form_x+12+i*110
        rounded_rect(d, (bx, fy, bx+100, fy+28), 8, fill=c["surf3"], outline=c["border"], width=1)
        d.text((bx+50, fy+14), lab, font=F11, fill=c["t2"], anchor="mm")
    fy+=38
    # steps table header
    d.text((form_x+12, fy), "Шаги  •  4  •  автодополнение ⌄", font=F11B, fill=c["t2"])
    fy+=16
    steps=[
        ("1","Launch.File","C:\\Music\\spotify.exe"),
        ("2","Sound.PlayWav","ding.wav"),
        ("3","Lux.PauseMS","200"),
        ("4","Mouse.ToCoords","1054, 862  •  взять с экрана"),
    ]
    for n, act, val in steps:
        rounded_rect(d, (form_x+12, fy, form_x+form_w-12, fy+28), 8, fill=c["surf"], outline=c["border"], width=1)
        d.text((form_x+18, fy+14), n, font=F11B, fill=c["t3"], anchor="lm")
        d.text((form_x+36, fy+14), act, font=F11, fill=C_ACCENT, anchor="lm")
        d.text((form_x+140, fy+14), val[:28], font=F11, fill=c["t2"], anchor="lm")
        # delete icon
        d.text((form_x+form_w-20, fy+14), "✕", font=F11, fill=c["t3"], anchor="mm")
        fy+=32
    # phrases
    d.text((form_x+12, fy+6), "Фразы: «включи музыку», «музыка вкл»  +  Необязательные: «пожалуйста»", font=F11, fill=c["t3"])
    # hide sphere panel? we keep but show sphere small top
    # draw sphere small in commands not needed — we keep sphere panel as pack preview?
    # sphere small
    d.text((sx+sw-44, ry+14), "—  □  ✕", font=F11, fill=c["t3"])
    sphere_cx=sx+sw//2
    sphere_cy=ry+80
    draw_sphere_wire(d, sphere_cx, sphere_cy, 56, accent=C_ACCENT, state="idle")
    d.text((sphere_cx, sphere_cy+70), "Паки: 9  •  530 команд", font=F11, fill=c["t3"], anchor="mm")
    d.text((sphere_cx, 220), "Карточки паков:", font=F11B, fill=c["t2"], anchor="mm")
    # pack cards mini
    py=240
    for pack in ["Браузер","Текст","Музыка"]:
        rounded_rect(d, (sx+12, py, sx+sw-12, py+52), 10, fill=c["surf2"], outline=c["border"], width=1)
        d.text((sx+20, py+14), pack, font=F12B, fill=c["t1"])
        d.text((sx+20, py+30), "12 команд  •  Установить →", font=F11, fill=c["t2"])
        py+=60
    img.save(os.path.join(PREV, "04-commands.png"))
    print("04-commands ok")

def mockup_settings():
    img,d,c, (rx,ry,rw,rh, hx,hw, cx,cw, sx,sw) = create_base("dark")
    draw_rail(d, rx,ry,rw,rh, "dark", "Настройки")
    # left nav inside chat area
    draw_history(d, hx,ry,hw,rh, "dark") # but for settings we will overwrite history with nav? Keep as settings nav
    # actually settings has its own nav 160px left inside cx
    # we draw settings layout inside chat panel
    # header search
    d.text((cx+16, ry+14), "Настройки", font=F16B, fill=c["t1"])
    search_x=cx+140
    rounded_rect(d, (search_x, ry+10, search_x+220, ry+34), 10, fill=c["surf3"], outline=c["border"], width=1)
    d.text((search_x+10, ry+22), "⌕  Поиск настроек…", font=F11, fill=c["t3"], anchor="lm")
    # chips
    chip_y=ry+48
    chips=["Все","ИИ","Вид","Голос","Сфера"]
    cx_chip=cx+16
    for chip in chips:
        active = chip=="Сфера"
        bg=c["accent"] if active else c["surf2"]
        fg="#FFFFFF" if active else c["t2"]
        tw=d.textbbox((0,0), chip, font=F11)[2]+20
        rounded_rect(d, (cx_chip, chip_y, cx_chip+tw, chip_y+26), 99, fill=bg, outline=bg if active else c["border"], width=1)
        d.text((cx_chip+tw//2, chip_y+13), chip, font=F11, fill=fg, anchor="mm")
        cx_chip+=tw+8
    # left nav
    nav_x=cx+16
    nav_w=160
    nav_y=chip_y+36
    nav_h=rh-100
    rounded_rect(d, (nav_x, nav_y, nav_x+nav_w, nav_y+nav_h), 12, fill=c["surf2"], outline=c["border"], width=1)
    sections=["Общие","ИИ и провайдеры","Вид","Голос","Безопасность","Сфера Nox"]
    y=nav_y+12
    for s in sections:
        active=s=="Сфера Nox"
        if active:
            rounded_rect(d, (nav_x+8, y-4, nav_x+nav_w-8, y+20), 8, fill=c["accent"]+"22" if False else "#1A2E3A", outline=None)
            d.rounded_rectangle((nav_x+8, y-4, nav_x+nav_w-8, y+20), radius=8, fill="#1A2E3A")
        col=c["accent"] if active else c["t2"]
        d.text((nav_x+16, y+8), s, font=F11B if active else F11, fill=col, anchor="lm")
        y+=26
    # main cards
    card_x=nav_x+nav_w+12
    card_w=cw - (nav_w+40)
    y=nav_y
    # card 1: Sphere variant
    rounded_rect(d, (card_x, y, card_x+card_w, y+112), 12, fill=c["surf2"], outline=c["border"], width=1)
    d.text((card_x+14, y+14), "Сфера Nox", font=F12B, fill=c["t1"])
    d.text((card_x+card_w-28, y+14), "↻", font=F12, fill=c["t3"], anchor="mm")
    # preview canvas 84px
    pv=card_x+14
    pv_y=y+30
    rounded_rect(d, (pv, pv_y, pv+84, pv_y+72), 10, fill="#0F0F10", outline=c["border"], width=1)
    draw_sphere_dots(ImageDraw.Draw(img, "RGBA"), pv+42, pv_y+36, 28, accent=C_ACCENT, state="idle")
    # Actually draw on main d: need separate draw call with proper coords — we already drew on img directly? Let's draw again on d
    draw_sphere_dots(d, pv+42, pv_y+36, 28, accent=C_ACCENT, state="idle")
    # variant switch
    seg_x=pv+104
    seg_y=pv_y+8
    rounded_rect(d, (seg_x, seg_y, seg_x+160, seg_y+28), 99, fill=c["surf"], outline=c["border"], width=1)
    # active Wire / Nox
    rounded_rect(d, (seg_x+2, seg_y+2, seg_x+80, seg_y+26), 99, fill=c["accent"], outline=c["accent"], width=1)
    d.text((seg_x+40, seg_y+14), "Wire", font=F11B, fill="#FFFFFF", anchor="mm")
    d.text((seg_x+120, seg_y+14), "Точки", font=F11, fill=c["t2"], anchor="mm")
    d.text((seg_x, seg_y+40), "Размер  S  ● M  L   •   Свечение  ──●──", font=F11, fill=c["t3"])
    y+=122
    # card 2: Motion tuning
    rounded_rect(d, (card_x, y, card_x+card_w, y+96), 12, fill=c["surf2"], outline=c["border"], width=1)
    d.text((card_x+14, y+14), "Анимация и отклик", font=F12B, fill=c["t1"])
    # sliders
    for i, (label, val) in enumerate([("Чувствительность",50),("Амплитуда",50),("Инерция",50)]):
        sx1=card_x+14
        sy=y+34+i*18
        d.text((sx1, sy), label, font=F11, fill=c["t3"])
        # track
        tx=sx1+110
        d.rounded_rectangle((tx, sy+4, tx+110, sy+8), radius=2, fill="#2A2A2E")
        # fill
        d.rounded_rectangle((tx, sy+4, tx+60, sy+8), radius=2, fill=c["accent"])
        # thumb
        d.ellipse([tx+58, sy, tx+66, sy+12], fill="#FFFFFF", outline=c["border"], width=1)
        d.text((tx+120, sy+6), f"{val}%", font=F11, fill=c["t2"], anchor="lm")
    y+=106
    # card 3: Theme accent
    rounded_rect(d, (card_x, y, card_x+card_w, y+88), 12, fill=c["surf2"], outline=c["border"], width=1)
    d.text((card_x+14, y+14), "Цвет акцента", font=F12B, fill=c["t1"])
    d.text((card_x+14, y+30), "Как в теме  •  7 пресетов + HEX", font=F11, fill=c["t3"])
    # color dots
    dot_x=card_x+14
    dot_y=y+52
    for j, col in enumerate(["#6AA6FF","#AB92FF","#5EE0A0","#FF86BC","#FFA55E","#4FD6C8","#D3DAE2"]):
        sel=j==0
        rgb=hex_to_rgb(col)
        d.ellipse([dot_x+j*28, dot_y, dot_x+j*28+20, dot_y+20], fill=col, outline="#FFFFFF" if sel else col, width=2 if sel else 1)
        if sel:
            d.ellipse([dot_x+j*28+6, dot_y+6, dot_x+j*28+14, dot_y+14], fill="#FFFFFF")
    # hex field
    rounded_rect(d, (dot_x+220, dot_y, dot_x+300, dot_y+22), 8, fill=c["surf3"], outline=c["border"], width=1)
    d.text((dot_x+228, dot_y+11), "#2E9AC1", font=F11, fill=c["t1"], anchor="lm")
    # contrast hint
    d.text((card_x+14, y+78), "Контраст ≥4.5:1 — проверено на фоне #0F0F10", font=F10, fill=C_OK)
    # sphere panel right (preview large)
    d.text((sx+sw-44, ry+14), "—  □  ✕", font=F11, fill=c["t3"])
    sphere_cx=sx+sw//2
    sphere_cy=ry+rh//2 -10
    draw_sphere_wire(d, sphere_cx, sphere_cy, 84, accent=C_ACCENT, state="idle")
    d.text((sphere_cx, sphere_cy+98), "Wire  •  дыхание 2.1с", font=F11, fill=c["t3"], anchor="mm")
    d.text((sphere_cx, sphere_cy+112), "Якорь за край: выкл", font=F11, fill=c["t2"], anchor="mm")
    rounded_rect(d, (sx+16, sphere_cy+128, sx+sw-16, sphere_cy+152), 8, fill=c["surf2"], outline=c["border"], width=1)
    d.text((sx+sw//2, sphere_cy+140), "Сфера следует акценту — #2E9AC1", font=F11, fill=c["t2"], anchor="mm")
    img.save(os.path.join(PREV, "05-settings.png"))
    print("05-settings ok")

def mockup_light():
    img,d,c, (rx,ry,rw,rh, hx,hw, cx,cw, sx,sw) = create_base("light")
    draw_rail(d, rx,ry,rw,rh, "light", "Главная")
    draw_history(d, hx,ry,hw,rh, "light")
    chat_x=cx+20
    chat_w=cw-40
    y=ry+16
    d.text((chat_x, y), "Сегодня  •  14:35  •  Светлая тема", font=F11, fill=c["t3"])
    y+=18
    bw=340
    bx=chat_x+chat_w-bw-8
    rounded_rect(d, (bx, y, bx+bw, y+44), 12, fill=c["surf3"], outline=c["border"], width=1)
    d.text((bx+12, y+10), "Привет, Nox. Как выгляжу в светлой теме?", font=F13, fill=c["t1"])
    d.text((bx+12, y+26), "10:16", font=F10, fill=c["t3"])
    y+=60
    d.text((chat_x, y), "NOX", font=F11B, fill=c["t3"])
    y+=14
    lines=["Отлично — панели #FFFDF9 на фоне #F4F1EB,",
           "акцент #2F5FD0, сфера ярче для читаемости.",
           "Контраст текста 14:1 — всё читается."]
    for l in lines:
        d.text((chat_x, y), l, font=F13, fill=c["t1"])
        y+=18
    y+=10
    # chips
    chip_x=chat_x
    for chip in ["Разобрать почту","Показать календарь"]:
        tw=d.textbbox((0,0), chip, font=F12)[2]+24
        rounded_rect(d, (chip_x, y, chip_x+tw, y+28), 99, fill=c["surf2"], outline=c["border"], width=1)
        d.text((chip_x+12, y+14), chip, font=F12, fill=c["t2"], anchor="lm")
        chip_x+=tw+8
    y+=40
    rounded_rect(d, (chat_x, y, chat_x+40, y+22), 7, fill=None, outline=c["border"], width=1)
    d.text((chat_x+20, y+11), "⎘", font=F11, fill=c["t3"], anchor="mm")
    # composer light
    comp_y=ry+rh-62
    comp_x=cx+12
    comp_w=cw-24
    rounded_rect(d, (comp_x, comp_y, comp_x+comp_w, comp_y+50), 16, fill=c["surf2"], outline=c["border"], width=1)
    d.text((comp_x+14, comp_y+14), "Спроси Nox…", font=F13, fill=c["t3"])
    icon_y=comp_y+34
    d.text((comp_x+14, icon_y), "📎", font=F12, fill=c["t3"], anchor="lm")
    d.text((comp_x+38, icon_y), "◫", font=F12, fill=c["t3"], anchor="lm")
    pill="Быстрая  •  Подумать"
    tw=d.textbbox((0,0), pill, font=F11)[2]+20
    px=comp_x+comp_w-160-tw
    rounded_rect(d, (px, icon_y-11, px+tw, icon_y+11), 99, fill=c["surf3"], outline=c["border"], width=1)
    d.text((px+10, icon_y), pill, font=F11, fill=c["t2"], anchor="lm")
    mx=comp_x+comp_w-64
    d.ellipse([mx, icon_y-14, mx+28, icon_y+14], fill=c["surf3"], outline=c["border"], width=1)
    d.text((mx+14, icon_y), "◉", font=F11, fill=c["t2"], anchor="mm")
    sxb=comp_x+comp_w-30
    d.ellipse([sxb, icon_y-14, sxb+28, icon_y+14], fill=c["accent"], outline=c["accent"], width=1)
    d.text((sxb+14, icon_y), "↑", font=F12B, fill="#FFFFFF", anchor="mm")
    # sphere light
    d.text((sx+sw-44, ry+14), "—  □  ✕", font=F11, fill=c["t3"])
    sphere_cx=sx+sw//2
    sphere_cy=ry+rh//2 -8
    draw_sphere_dots(d, sphere_cx, sphere_cy, 112, accent=L_ACCENT, state="idle", light_bg=True)
    d.text((sphere_cx, sphere_cy+128), "Светлая • #F4F1EB • акцент #2F5FD0", font=F11, fill=c["t3"], anchor="mm")
    d.text((sphere_cx, sphere_cy+142), "Контраст 14:1 — панели #FFFDF9", font=F11, fill=c["t2"], anchor="mm")
    img.save(os.path.join(PREV, "06-light.png"))
    print("06-light ok")

def storyboard_sphere():
    # 8 states strip: idle/listening/thinking/speaking/executing/waiting/success/error
    states=[
        ("idle","покой 2.1с",C_ACCENT),
        ("listening","слушаю",C_ACCENT),
        ("thinking","думаю",C_ACCENT),
        ("speaking","говорю",C_ACCENT),
        ("executing","выполняю",C_ACCENT),
        ("waiting","жду",C_WARN),
        ("success","готово",C_OK),
        ("error","ошибка",C_ERR),
    ]
    W2=1200
    H2=480
    img=Image.new("RGB", (W2,H2), "#0F0F10")
    d=ImageDraw.Draw(img, "RGBA")
    # title
    d.text((20,16), "Nox — Состояния сферы  •  8 состояний  •  один период дыхания  •  цвета из токенов темы", font=F13, fill=C_TEXT2)
    # grid 4x2
    cols=4
    rows=2
    cell_w=W2//cols
    cell_h=(H2-40)//rows
    for idx, (state, label, accent) in enumerate(states):
        col=idx%cols
        row=idx//cols
        cx=col*cell_w + cell_w//2
        cy=40+row*cell_h + cell_h//2 -10
        # cell border
        x0=col*cell_w+8
        y0=40+row*cell_h+4
        x1=(col+1)*cell_w-8
        y1=40+(row+1)*cell_h-4
        rounded_rect(d, (x0,y0,x1,y1), 12, fill="#18181B", outline="#2A2A2E", width=1)
        # sphere
        R=56
        draw_sphere_dots(d, cx, cy, R, accent=accent, state=state)
        # label
        d.text((cx, y1-18), f"{label}", font=F11B, fill="#F1F1F3", anchor="mm")
        d.text((cx, y1-6), f"{state}", font=F10, fill="#9A9AA0", anchor="mm")
        # state color dot
        d.ellipse([cx-3, y0+10, cx+3, y0+16], fill=accent)
    img.save(os.path.join(STORY, "sphere-states.png"))
    print("storyboard sphere-states ok")
    # motion strip: idle breathing 5 phases
    W3=1200
    H3=260
    img3=Image.new("RGB", (W3,H3), "#0F0F10")
    d3=ImageDraw.Draw(img3, "RGBA")
    d3.text((20,16), "Nox — Дыхание сферы idle  •  период 2.1с  •  5 фаз  •  волна внутрь lag 0.15с", font=F13, fill=C_TEXT2)
    phases=[0,0.25,0.5,0.75,1.0]
    for i, ph in enumerate(phases):
        cx=120+i*220 +110
        cy=140
        # simulate breathing size by deform param
        # we approximate R variation: 100% ->102%->100%->98%->100%
        # but our draw function has fixed deform; we instead scale R
        scale = 1 + 0.02*math.sin(ph*2*math.pi)
        R=int(64*scale)
        # lag not visible in static but we add note
        d3.text((cx, cy+80), f"{ph*2.1:.2f}с", font=F11, fill=C_TEXT3, anchor="mm")
        d3.text((cx, cy+92), f"R {scale*100:.1f}%", font=F10, fill=C_TEXT3, anchor="mm")
        draw_sphere_dots(d3, cx, cy, R, accent=C_ACCENT, state="idle")
    d3.text((W3//2, H3-16), "idle → listening → thinking → speaking — непрерывность 280ms ease-out, phase не сбрасывается", font=F11, fill=C_TEXT3, anchor="mm")
    img3.save(os.path.join(STORY, "sphere-motion-strip.png"))
    print("motion strip ok")

if __name__=="__main__":
    mockup_main()
    mockup_agent()
    mockup_voice()
    mockup_commands()
    mockup_settings()
    mockup_light()
    storyboard_sphere()
    print("All previews generated")

