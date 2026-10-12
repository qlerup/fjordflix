local real=require 'mp'
local function test()
    local props={duration=100,['time-pos']=89,pause=false}
    local keys,messages={},{}
    local rendered,tick,requested='',nil,0
    local fake={}
    function fake.get_time() return 10 end
    function fake.get_property_native(k,fallback) if props[k]~=nil then return props[k] end; return fallback end
    function fake.get_osd_size() return 1280,720 end
    function fake.get_mouse_pos() return 1000,490 end
    function fake.create_osd_overlay() return {update=function(self) rendered=self.data end,remove=function() rendered='' end} end
    function fake.command_native(c) if c[1]=='escape-ass' then return c[2] end end
    function fake.commandv(c,...)
        local a={...}
        if c=='script-message' and a[1]=='fjord-next-episode' then requested=requested+1 end
        return true
    end
    function fake.add_forced_key_binding(_,name,fn) keys[name]=fn end
    function fake.register_script_message(name,fn) messages[name]=fn end
    function fake.register_event() end
    function fake.observe_property() end
    function fake.add_periodic_timer(_,fn) tick=fn end
    package.loaded.mp=fake;dofile('desktop/player.lua')
    messages['fjord-next-available']('yes');tick()
    assert(not rendered:find('Næste afsnit',1,true))
    props['time-pos']=90;tick();assert(rendered:find('Næste afsnit afspilles om 10 sek.',1,true))
    props.pause=true;tick();tick();assert(rendered:find('om 10 sek.',1,true))
    props['time-pos']=40;tick();assert(not rendered:find('Næste afsnit',1,true))
    props['time-pos']=94;tick();assert(rendered:find('om 6 sek.',1,true))
    keys['fjord-click']({event='down'});keys['fjord-click']({event='up'})
    assert(requested==1,'click must request one handoff')
    tick();assert(not rendered:find('Næste afsnit',1,true))
    messages['fjord-next-available']('no');props['time-pos']=99;tick()
    assert(not rendered:find('Næste afsnit',1,true),'no button on movie or last episode')
end
local ok,err=pcall(test)
if ok then real.msg.info('PASS: native next episode countdown and click') else real.msg.error(tostring(err)) end
real.commandv('quit',ok and 0 or 1)
