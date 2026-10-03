-- Deterministic slow-seek regression: the decoder deliberately retains its old
-- time-pos until the simulated playback-restart event is delivered.
local real=require 'mp'
local function test()
    local props={duration=60,['time-pos']=0,pause=false}
    local keys,events,messages={}, {}, {}
    local now,mx,my=10,640,605
    local rendered='', last_request, bitmap, tick
    local fake={}
    function fake.get_time() return now end
    function fake.get_property_native(k,fallback) if props[k]~=nil then return props[k] end; return fallback end
    function fake.get_osd_size() return 1280,720 end
    function fake.get_mouse_pos() return mx,my end
    function fake.create_osd_overlay() return {update=function(self) rendered=self.data end,remove=function() end} end
    function fake.command_native(c) if c[1]=='escape-ass' then return c[2] end; if c.name=='overlay-add' then bitmap=c end end
    function fake.commandv(c,...)
        local a={...}
        if c=='script-message' and a[1]=='fjord-preview-request' then last_request=a end
        if c=='overlay-remove' then bitmap=nil end
        return true
    end
    function fake.add_forced_key_binding(_,name,fn) keys[name]=fn end
    function fake.register_script_message(name,fn) messages[name]=fn end
    function fake.register_event(name,fn) events[name]=fn end
    function fake.observe_property() end
    function fake.add_periodic_timer(_,fn) tick=fn end
    package.loaded.mp=fake
    dofile('desktop/player.lua')
    keys['fjord-click']({event='down'});keys['fjord-click']({event='up'})
    mx,my=10,200;tick()
    assert(rendered:find('0:30',1,true),'target time must render before decoder time changes')
    assert(rendered:find('Gør klar',1,true),'pending seek must remain visible after pointer leaves')
    assert(rendered:find('5120 4856',1,true),'red timeline must reach midpoint while decoder is still at zero')
    messages['fjord-preview-ready'](last_request[2],last_request[3],'preview.bgra')
    assert(bitmap and bitmap.file=='preview.bgra','target preview is shown while waiting')
    local old=last_request
    now=11;keys['fjord-seek-RIGHT']();now=12;keys['fjord-seek-RIGHT']()
    assert(rendered:find('0:50',1,true),'repeated seeks accumulate from requested position')
    messages['fjord-preview-ready'](old[2],old[3],'stale.bgra')
    assert(not bitmap,'stale image must not replace latest target')
    props['time-pos']=30;events['playback-restart']()
    assert(rendered:find('Gør klar',1,true),'old restart cannot finish a newer seek')
    props['time-pos']=50;events['playback-restart']()
    assert(not rendered:find('Gør klar',1,true),'ready frame clears loading state')
end
local ok,err=pcall(test)
if not ok then real.msg.error(tostring(err)) else real.msg.info('PASS: optimistic timeline, pending preview, rapid seeks and stale completion') end
real.commandv('quit',ok and 0 or 1)
