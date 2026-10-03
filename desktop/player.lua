-- FjordFlix native controls. Drawn by mpv on top of the original video.
local mp = require 'mp'
local assdraw = require 'mp.assdraw'
local overlay = mp.create_osd_overlay('ass-events')
local W, H, mx, my = 1280, 720, -1, -1
local areas, menu, scroll, focus = {}, nil, 0, 0
local title, last_move, drag = 'FjordFlix', mp.get_time(), nil
local white, muted, red, panel = 'FFFFFF', 'B7B5BC', '5640F4', '1D1919'
local draw
local pending_seek, preview_file, preview_target, requested_target
local preview_serial, preview_request_time = 0, 0
local function clear_preview()
    preview_file=nil; mp.commandv('overlay-remove',42)
end
local function request_preview(target)
    target=math.floor(target+0.5)
    if target==requested_target then return end
    if mp.get_time()-preview_request_time<0.25 then return end
    preview_request_time=mp.get_time(); requested_target=target; preview_serial=preview_serial+1
    clear_preview()
    mp.commandv('script-message','fjord-preview-request',tostring(preview_serial),tostring(target))
end
local function prop(n, fallback) return mp.get_property_native(n, fallback) end
local function clamp(v, a, b) return math.max(a, math.min(b, v)) end
local function clock(s)
    s = math.max(0, math.floor(s or 0))
    if s >= 3600 then return string.format('%d:%02d:%02d', math.floor(s/3600), math.floor(s/60)%60, s%60) end
    return string.format('%d:%02d', math.floor(s/60), s%60)
end
local function clean(s, limit)
    s = tostring(s or ''):gsub('[\r\n]', ' ')
    -- Truncate UTF-8 by characters, never split a Danish letter.
    local chars = {}; for c in s:gmatch('[%z\1-\127\194-\244][\128-\191]*') do chars[#chars+1] = c end
    if #chars > limit then s = table.concat(chars, '', 1, limit-1)..'…' end
    return mp.command_native({'escape-ass', s})
end
local function text(a,x,y,s,size,color,align,bold,limit)
    a:new_event(); a:pos(x,y)
    a:append(string.format('{\\an%d\\fnSegoe UI\\fs%d\\bord0\\shad0\\1c&H%s&\\b%d}',align or 4,size,color or white,bold and 1 or 0))
    a:append(clean(s,limit or 100))
end
local function box(a,x,y,w,h,color,alpha,radius)
    a:new_event(); a:pos(0,0); a:append('{\\bord0\\shad0\\1c&H'..color..'&\\1a&H'..(alpha or '00')..'&}')
    a:draw_start(); a:round_rect_cw(x,y,x+w,y+h,radius or 0); a:draw_stop()
end
local function hit(b) return mx>=b.x and mx<=b.x+b.w and my>=b.y and my<=b.y+b.h end
local function area(x,y,w,h,fn,tip)
    local b={x=x,y=y,w=w,h=h,fn=fn,tip=tip}; areas[#areas+1]=b; return b
end
local function icon(a,x,y,kind)
    a:new_event(); a:pos(x,y); a:append('{\\bord0\\shad0\\1c&HFFFFFF&}')
    a:draw_start()
    if kind=='play' then a:move_to(-6,-9); a:line_to(9,0); a:line_to(-6,9)
    elseif kind=='pause' then a:rect_cw(-7,-9,-2,9); a:rect_cw(3,-9,8,9)
    elseif kind=='back' then
        a:move_to(-10,0); a:line_to(-1,-9); a:line_to(1,-7); a:line_to(-5,-1); a:line_to(10,-1); a:line_to(10,1); a:line_to(-5,1); a:line_to(1,7); a:line_to(-1,9)
    elseif kind=='full' then
        for _,p in ipairs({{-9,-9,1,1},{9,-9,-1,1},{-9,9,1,-1},{9,9,-1,-1}}) do
            a:move_to(p[1],p[2]+p[4]*7); a:line_to(p[1],p[2]); a:line_to(p[1]+p[3]*7,p[2]); a:line_to(p[1]+p[3]*7,p[2]+p[4]*2); a:line_to(p[1]+p[3]*2,p[2]+p[4]*2); a:line_to(p[1]+p[3]*2,p[2]+p[4]*7)
        end
    elseif kind=='volume' or kind=='mute' then
        a:move_to(-10,-4); a:line_to(-5,-4); a:line_to(1,-9); a:line_to(1,9); a:line_to(-5,4); a:line_to(-10,4)
        if kind=='volume' then a:rect_cw(5,-5,7,5); a:rect_cw(10,-8,12,8)
        else a:move_to(5,-5); a:line_to(12,4); a:line_to(10,6); a:line_to(3,-3) end
    end
    a:draw_stop()
end
local function button(a,x,y,w,label,fn,tip,primary)
    local b=area(x,y,w,44,fn,tip)
    local selected=hit(b) or focus==#areas
    if primary or selected then box(a,x,y,w,44,primary and red or '49413F','00',primary and 22 or 10) end
    if label:sub(1,1)=='@' then icon(a,x+w/2,y+22,label:sub(2))
    else text(a,x+w/2,y+22,label,18,white,5,true) end
    if focus==#areas then box(a,x+10,y+40,w-20,2,white) end
end
local function open_menu(kind)
    menu=menu==kind and nil or kind; scroll=0; focus=0; last_move=mp.get_time(); draw()
end
local function track_items(kind)
    local rows={}
    if kind=='sub' then rows[1]={id='no',label='Fra',selected=not prop('sid',false)} end
    local languages={dan='Dansk',eng='Engelsk',deu='Tysk',ger='Tysk',swe='Svensk',nor='Norsk',fra='Fransk',fre='Fransk',spa='Spansk',und='Ukendt sprog'}
    for _,t in ipairs(prop('track-list',{})) do
        if t.type==kind then
            local label=languages[t.lang] or t.lang or ('Spor '..t.id)
            if t.title and t.title~='' then label=label..' · '..t.title end
            if t['audio-channels'] then label=label..' · '..t['audio-channels']..' kanaler' end
            if t.external then label=label..' · Ekstern' end
            rows[#rows+1]={id=t.id,label=label,selected=t.selected}
        end
    end
    return rows
end
local function seek_to(target)
    local duration=prop('duration',0)
    if duration<=0 then return end
    pending_seek=clamp(target,0,math.max(0,duration-0.1))
    last_move=mp.get_time()
    request_preview(pending_seek)
    draw()
    local ok=mp.commandv('seek',pending_seek,'absolute+exact')
    if not ok then pending_seek=nil; clear_preview(); draw() end
end
local function seek(x) seek_to(clamp((x-40)/(W-80),0,1)*prop('duration',0)) end
local function volume(x) mp.set_property_number('volume',clamp((x-294)/100,0,1)*100) end
draw=function()
    local sw,sh=mp.get_osd_size(); if not sw or sw<1 or sh<1 then return end
    H=720; W=math.max(640,sw/sh*H)
    local px,py=mp.get_mouse_pos(); mx=px/sw*W; my=py/sh*H
    local visible=pending_seek or menu or drag or focus>0 or prop('pause',false) or mp.get_time()-last_move<3
    areas={}
    if not visible then overlay:remove(); mp.commandv('overlay-remove',42); return end
    local a=assdraw.ass_new()
    -- Soft scrims keep controls legible without framing the film in a toolbar.
    for i=0,47 do
        box(a,0,i*3,W,3,'000000',string.format('%02X',math.floor(70+i*185/47)))
        box(a,0,H-192+i*4,W,4,'000000',string.format('%02X',math.floor(255-i*220/47)))
    end
    button(a,32,28,48,'@back',function() mp.commandv('quit') end,'Tilbage til bibliotek')
    text(a,100,36,'FJORD FLIX',12,muted,4,true)
    text(a,100,64,title,24,white,4,true,math.max(15,math.floor((W-180)/14)))
    local pos,duration=pending_seek or prop('time-pos',0),prop('duration',0)
    if drag=='seek' then pos=clamp((mx-40)/(W-80),0,1)*duration end
    text(a,40,H-139,clock(pos),15,white)
    text(a,W-40,H-139,duration>0 and ('−'..clock(duration-pos)) or 'Indlæser…',15,muted,6)
    local sy=H-115
    box(a,40,sy,W-80,5,'66615E','40',2)
    local endpos=prop('demuxer-cache-state',{})['cache-end']
    if duration>0 and endpos then box(a,40,sy,(W-80)*clamp(endpos/duration,0,1),5,'AAA5A2','50',2) end
    local progress=duration>0 and clamp(pos/duration,0,1) or 0
    if drag=='seek' then progress=clamp((mx-40)/(W-80),0,1) end
    box(a,40,sy,(W-80)*progress,5,red,'00',2)
    box(a,40+(W-80)*progress-6,sy-4,13,13,white,'00',6)
    local timeline=area(40,sy-14,W-80,32,function() seek(mx) end,'Spol')
    timeline.kind='seek'
    local preview_at=pending_seek or ((hit(timeline) or drag=='seek') and duration>0 and clamp((mx-40)/(W-80),0,1)*duration or nil)
    if preview_at then request_preview(preview_at) end
    if preview_at and preview_file and math.abs(preview_target-preview_at)<=0.55 and not menu then
        -- Bitmap overlays sit above ASS controls, so reserve their own area.
        local pw=pending_seek and math.min(W-100,(H-310)*16/9) or 240
        local ph=pw*9/16
        local px=pending_seek and (W-pw)/2 or clamp(mx-pw/2,40,W-40-pw)
        local py=pending_seek and (H-180-ph)/2 or sy-ph-64
        mp.command_native({name='overlay-add',id=42,x=math.floor(px*sw/W),y=math.floor(py*sh/H),
            file=preview_file,offset=0,fmt='bgra',w=640,h=360,stride=2560,dw=math.floor(pw*sw/W),dh=math.floor(ph*sh/H)})
    else mp.commandv('overlay-remove',42) end
    if hit(timeline) and duration>0 then
        local tx=clamp(mx,75,W-75)
        box(a,tx-40,sy-54,80,32,panel,'00',8)
        text(a,tx,sy-38,clock(clamp((mx-40)/(W-80),0,1)*duration),15,white,5)
    end
    local y=H-86
    button(a,40,y,52,prop('pause',false) and '@play' or '@pause',function() mp.commandv('cycle','pause') end,'Afspil / pause · Mellemrum',true)
    button(a,104,y,54,'−10',function() seek_to((pending_seek or prop('time-pos',0))-10) end,'10 sekunder tilbage · ←')
    button(a,168,y,54,'+10',function() seek_to((pending_seek or prop('time-pos',0))+10) end,'10 sekunder frem · →')
    if W>850 then
        button(a,236,y,48,prop('mute',false) and '@mute' or '@volume',function() mp.commandv('cycle','mute') end,'Lyd til / fra · M')
        local v=clamp(prop('volume',100),0,100)
        box(a,294,y+20,100,4,'66615E','00',2); box(a,294,y+20,v,4,white,'00',2)
        local vol=area(294,y,100,44,function() volume(mx) end,'Lydstyrke'); vol.kind='volume'
    end
    button(a,W-344,y,86,'Lyd',function() open_menu('audio') end,'Vælg lydspor · A')
    button(a,W-246,y,140,'Undertekster',function() open_menu('sub') end,'Vælg undertekster · S')
    button(a,W-94,y,54,'@full',function() mp.commandv('cycle','fullscreen') end,'Fuldskærm · F')
    text(a,40,H-20,'ORIGINAL KVALITET',11,muted,4,true)
    text(a,W-40,H-20,'FJORD FLIX',11,muted,6,true)
    if pending_seek or prop('paused-for-cache',false) then
        local ly=pending_seek and H-205 or H/2
        box(a,W/2-125,ly-28,250,56,panel,'20',14)
        text(a,W/2,ly,(pending_seek and 'Gør klar · '..clock(pending_seek) or 'Indlæser')..string.rep('·',math.floor(mp.get_time()*2)%4),20,white,5)
    end
    if menu then
        local rows=track_items(menu)
        local count=math.min(#rows,7); scroll=clamp(scroll,0,math.max(0,#rows-count))
        local mw=math.min(500,W-64); local x=W-mw-32; local top=H-160-92-count*46
        -- Underlying controls are inert while a menu is open.
        areas={}; box(a,x,top,mw,92+count*46,panel,'00',16)
        text(a,x+22,top+30,menu=='audio' and 'Lydspor' or 'Undertekster',22,white,4,true)
        button(a,x+mw-58,top+8,44,'×',function() menu=nil; focus=0 end,'Luk menu · Esc')
        if #rows==0 then text(a,x+22,top+68,'Ingen lydspor',16,muted) end
        for i=1,count do
            local row=rows[scroll+i]; local ry=top+58+(i-1)*46
            local b=area(x+10,ry,mw-20,42,function()
                mp.set_property(menu=='audio' and 'aid' or 'sid',row.id); menu=nil; focus=0
            end)
            if row.selected or hit(b) or focus==#areas then box(a,b.x,b.y,b.w,b.h,row.selected and '3B2B39' or '393333','00',8) end
            text(a,x+24,ry+21,row.selected and '✓' or '○',18,row.selected and red or muted)
            text(a,x+56,ry+21,row.label,16,white,4,false,math.floor((mw-85)/8.5))
        end
        if #rows>count then text(a,x+22,top+76+count*46,string.format('%d–%d af %d · Rul for flere spor',scroll+1,scroll+count,#rows),12,muted) end
    else
        for _,b in ipairs(areas) do
            if hit(b) and b.tip and b.kind~='seek' then text(a,clamp(b.x+b.w/2,160,W-160),H-164,b.tip,14,white,5) end
        end
    end
    overlay.res_x=W; overlay.res_y=H; overlay.data=a.text; overlay:update()
end
local function wake() last_move=mp.get_time(); draw() end
mp.add_forced_key_binding('mouse_move','fjord-mouse',function()
    last_move=mp.get_time(); focus=0; draw()
    if drag=='volume' then volume(mx) end
end)
mp.add_forced_key_binding('MBTN_LEFT','fjord-click',function(e)
    if e.event=='up' then if drag=='seek' then seek(mx) end; drag=nil; wake(); return end
    if e.event~='down' and e.event~='press' then return end
    wake()
    for _,b in ipairs(areas) do if hit(b) then drag=b.kind; if b.kind~='seek' then b.fn() end; wake(); return end end
    if menu then menu=nil; focus=0 else mp.commandv('cycle','pause') end; wake()
end,{complex=true})
mp.add_forced_key_binding('MBTN_LEFT_DBL','fjord-double',function() if not menu and my<H-180 then mp.commandv('cycle','fullscreen') end end)
for key,delta in pairs({WHEEL_UP=-1,WHEEL_DOWN=1}) do
    mp.add_forced_key_binding(key,'fjord-'..key,function()
        if menu then scroll=scroll+delta; focus=0 else mp.set_property_number('volume',clamp(prop('volume',100)-delta*5,0,100)) end; wake()
    end)
end
for key,delta in pairs({UP=-1,DOWN=1}) do
    mp.add_forced_key_binding(key,'fjord-nav-'..key,function()
        if menu then
            if (delta>0 and focus>=#areas) or (delta<0 and focus<=2 and scroll>0) then scroll=scroll+delta
            else focus=clamp(focus+delta,1,#areas) end
        else seek_to((pending_seek or prop('time-pos',0))-delta*60) end
        wake()
    end,{repeatable=true})
end
for key,delta in pairs({LEFT=-1,RIGHT=1}) do
    mp.add_forced_key_binding(key,'fjord-seek-'..key,function()
        if not menu then
            if areas[focus] and areas[focus].kind=='volume' then mp.set_property_number('volume',clamp(prop('volume',100)+delta*5,0,100))
            else seek_to((pending_seek or prop('time-pos',0))+delta*10) end
        end
        wake()
    end,{repeatable=true})
end
mp.add_forced_key_binding('a','fjord-audio',function() open_menu('audio') end)
mp.add_forced_key_binding('s','fjord-sub',function() open_menu('sub') end)
mp.add_forced_key_binding('ESC','fjord-escape',function()
    if menu then menu=nil; focus=0 elseif prop('fullscreen',false) then mp.set_property_bool('fullscreen',false) else mp.commandv('quit') end; wake()
end)
mp.add_forced_key_binding('TAB','fjord-tab',function() wake(); focus=focus%math.max(1,#areas)+1; draw() end)
mp.add_forced_key_binding('Shift+TAB','fjord-backtab',function() wake(); focus=(focus-2)%math.max(1,#areas)+1; draw() end)
mp.add_forced_key_binding('ENTER','fjord-enter',function() if areas[focus] then areas[focus].fn() end; wake() end)
mp.register_script_message('fjord-title',function(value) title=value; wake() end)
mp.register_script_message('fjord-preview-ready',function(serial,target,file)
    if tonumber(serial)~=preview_serial then return end
    preview_file=file; preview_target=tonumber(target); draw()
end)
mp.register_event('playback-restart',function()
    if pending_seek and not prop('seeking',false) and math.abs(prop('time-pos',0)-pending_seek)<2 then
        pending_seek=nil; clear_preview(); wake()
    end
end)
mp.register_event('end-file',function() pending_seek=nil; requested_target=nil; preview_serial=preview_serial+1; clear_preview() end)
for _,name in ipairs({'pause','time-pos','duration','track-list','aid','sid','volume','mute','fullscreen','osd-dimensions','paused-for-cache'}) do mp.observe_property(name,'native',draw) end
mp.add_periodic_timer(0.2,draw)
