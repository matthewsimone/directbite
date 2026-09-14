import { useEffect, useRef, useState } from 'react'

import applePay from '../assets/landing/apple-pay.svg'
import gpayMark from '../assets/landing/gpay-mark.png'
import menuFriedMozzarella from '../assets/landing/menu-fried-mozzarella.jpg'
import menuJamminBrussels from '../assets/landing/menu-jammin-brussels.jpg'
import menuParmigiana from '../assets/landing/menu-parmigiana.jpg'
import ordrSignature from '../assets/landing/ordr-signature.png'
import rewardCheesePizza from '../assets/landing/reward-cheese-pizza.jpg'
import rewardChoppedSalad from '../assets/landing/reward-chopped-salad.jpg'
import stellaHero from '../assets/landing/stella-hero.jpg'
import uberDirect from '../assets/landing/uber-direct.svg'

// ── Contact Form Dialog ──
function ContactFormDialog({ open, onOpenChange, heading }) {
  const [submitting, setSubmitting] = useState(false)
  const [success, setSuccess] = useState(false)

  if (!open) return null

  async function handleSubmit(e) {
    e.preventDefault()
    setSubmitting(true)
    try {
      const formData = new FormData(e.currentTarget)
      formData.append('_subject', heading)
      const res = await fetch('https://formspree.io/f/mbdqlgwr', {
        method: 'POST',
        body: formData,
        headers: { Accept: 'application/json' },
      })
      if (!res.ok) throw new Error('Submit failed')
      setSuccess(true)
      setTimeout(() => { onOpenChange(false); setSuccess(false) }, 2000)
    } catch {
      alert('Something went wrong. Please try again.')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={() => onOpenChange(false)} />
      <div className="relative bg-white rounded-2xl w-full max-w-[440px] p-6 shadow-xl" style={{ animation: 'ordr-fadeInScale 0.2s ease-out' }}>
        <button onClick={() => onOpenChange(false)} className="absolute top-4 right-4 text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        <h2 className="text-xl font-semibold text-[#111] mb-1">{heading}</h2>
        <p className="text-sm text-[#6b7280] mb-5">Fill out the form below and we'll get back to you within 24 hours.</p>

        {success ? (
          <div className="text-center py-8">
            <div className="w-12 h-12 bg-[#16A34A] rounded-full flex items-center justify-center mx-auto mb-3">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <p className="font-semibold text-[#111]">Thanks!</p>
            <p className="text-sm text-[#6b7280]">We'll be in touch shortly.</p>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="text-sm font-medium text-[#111] mb-1 block">Your Name</label>
              <input name="name" required maxLength={100} placeholder="John Smith"
                className="w-full h-10 px-3 border border-[#e5e7eb] rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40" />
            </div>
            <div>
              <label className="text-sm font-medium text-[#111] mb-1 block">Restaurant Name</label>
              <input name="restaurant" required maxLength={100} placeholder="Simone's Pizza"
                className="w-full h-10 px-3 border border-[#e5e7eb] rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40" />
            </div>
            <div>
              <label className="text-sm font-medium text-[#111] mb-1 block">Zip Code</label>
              <input name="zip" required maxLength={10} placeholder="10001"
                className="w-full h-10 px-3 border border-[#e5e7eb] rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40" />
            </div>
            <div>
              <label className="text-sm font-medium text-[#111] mb-1 block">Email</label>
              <input name="email" type="email" required maxLength={255} placeholder="you@restaurant.com"
                className="w-full h-10 px-3 border border-[#e5e7eb] rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40" />
            </div>
            <div>
              <label className="text-sm font-medium text-[#111] mb-1 block">Phone Number</label>
              <input name="phone" type="tel" required maxLength={20} placeholder="(555) 123-4567"
                className="w-full h-10 px-3 border border-[#e5e7eb] rounded-lg text-base focus:outline-none focus:ring-2 focus:ring-[#16A34A]/40" />
            </div>
            <button type="submit" disabled={submitting}
              className="w-full h-10 bg-[#16A34A] text-white font-medium rounded-full hover:opacity-90 transition-opacity disabled:opacity-50 mt-2">
              {submitting ? 'Sending...' : 'Submit'}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}

// Every rule is scoped under .ordr-landing. This page ships alongside ~25 live
// restaurant storefronts that share one global stylesheet (src/index.css), so a
// bare `nav {}` or `:root {}` here would reach straight into the tablet and
// ordering UIs. Three deliberate departures from the standalone design file:
//   - overflow-x: clip, not hidden — `hidden` makes this div a scroll container
//     and the sticky nav silently stops sticking.
//   - the canvas colour lives on .ordr-landing, because index.css pins
//     body/#root to #ffffff and that is not ours to change.
//   - html { scroll-behavior: smooth } is dropped; we cannot style html from here.
// Keyframes are global no matter where they are declared, so they carry an
// ordr- prefix to stay clear of the animations index.css already defines.
const CSS = `
.ordr-landing, .ordr-landing *{box-sizing:border-box;margin:0;padding:0}
.ordr-landing{-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale}
.ordr-landing{--green:#22C55E;--green-mid:#16A34A;--green-deep:#0E7A38;--ink:#07100B;--ink-2:#3D4A43;--ink-3:#6E7B74;
 --line:rgba(7,16,11,.09);--line-soft:rgba(7,16,11,.055);--canvas:#FFFEFC}
.ordr-landing{font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--canvas);
 color:var(--ink);font-size:17px;line-height:1.6;overflow-x:clip}
.ordr-landing .wrap{max-width:1200px;margin:0 auto;padding:0 32px}
.ordr-landing a{text-decoration:none}
/* ---------- type ---------- */


.ordr-landing .display{font-size:clamp(38px,4.4vw,56px);line-height:1.05;letter-spacing:-.042em;font-weight:700}
.ordr-landing .display .gr{color:var(--green-deep)}
.ordr-landing .h2{font-size:clamp(28px,3.6vw,44px);line-height:1.08;letter-spacing:-.034em;font-weight:700}
.ordr-landing .h2 .gr{color:var(--green-deep)}
.ordr-landing .h3{font-size:21px;line-height:1.25;letter-spacing:-.02em;font-weight:700}
.ordr-landing .lede{font-size:clamp(17px,1.35vw,19.5px);line-height:1.55;color:var(--ink-2)}
.ordr-landing .eyebrow{font-size:11.5px;font-weight:700;letter-spacing:.15em;text-transform:uppercase;color:var(--green-deep)}

.ordr-landing .btn{display:inline-flex;align-items:center;gap:9px;height:52px;padding:0 26px;border-radius:999px;
 font-size:16px;font-weight:600;letter-spacing:-.012em;border:1px solid transparent;
 transition:transform .16s,box-shadow .16s,background .16s;white-space:nowrap;
 font-family:inherit;cursor:pointer;text-decoration:none}
.ordr-landing .btn:active{transform:scale(.985)}
.ordr-landing .btn-primary{background:var(--green-mid);color:#fff;box-shadow:0 10px 34px rgba(34,197,94,.30)}
.ordr-landing .btn-primary:hover{background:var(--green);box-shadow:0 12px 40px rgba(34,197,94,.42)}
.ordr-landing .btn-soft{background:rgba(255,255,255,.78);color:var(--ink);border-color:rgba(7,16,11,.08);
 backdrop-filter:blur(16px);box-shadow:0 1px 2px rgba(7,16,11,.04)}
.ordr-landing .btn-soft:hover{background:#fff}
.ordr-landing .btn-white{background:#fff;color:var(--ink)}
.ordr-landing .btn-glass{background:rgba(255,255,255,.08);color:#fff;border-color:rgba(255,255,255,.18)}
.ordr-landing .btn-sm{height:42px;padding:0 19px;font-size:14.5px}
/* ---------- plasma system ---------- */


.ordr-landing .plasma{position:absolute;inset:0;z-index:0;overflow:hidden;pointer-events:none}
.ordr-landing .blob{position:absolute;display:block;border-radius:50%;filter:blur(90px)}
.ordr-landing .b1{width:820px;height:720px;left:-16%;top:-24%;background:radial-gradient(circle at 42% 42%,rgba(34,197,94,.62),rgba(34,197,94,0) 66%)}
.ordr-landing .b2{width:800px;height:690px;left:20%;top:-32%;background:radial-gradient(circle,rgba(16,185,129,.50),rgba(16,185,129,0) 66%)}
.ordr-landing .b3{width:750px;height:760px;right:-14%;top:-10%;background:radial-gradient(circle,rgba(13,148,136,.42),rgba(13,148,136,0) 66%)}
.ordr-landing .b4{width:560px;height:510px;left:34%;bottom:-24%;background:radial-gradient(circle,rgba(163,230,53,.40),rgba(163,230,53,0) 68%)}
.ordr-landing .b5{width:510px;height:480px;left:-6%;bottom:-18%;background:radial-gradient(circle,rgba(52,211,153,.44),rgba(52,211,153,0) 68%)}
.ordr-landing .grain{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.28;mix-blend-mode:multiply;
 background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.42'/%3E%3C/svg%3E")}
.ordr-landing .pfill{position:absolute;inset:0;z-index:0;overflow:hidden;opacity:.5}
.ordr-landing .pfill i{position:absolute;display:block;border-radius:50%;filter:blur(46px)}
.ordr-landing .pgrain{position:absolute;inset:0;z-index:1;pointer-events:none;opacity:.13;mix-blend-mode:multiply;
 background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='140' height='140'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='.8' numOctaves='3'/%3E%3C/filter%3E%3Crect width='140' height='140' filter='url(%23n)' opacity='.42'/%3E%3C/svg%3E")}
/* ---------- announcement ---------- */


.ordr-landing .topbar{display:flex;align-items:center;justify-content:center;gap:13px;padding:12px 20px;font-size:14.5px;
 color:var(--ink-2);background:#fff;border-bottom:1px solid var(--line-soft);flex-wrap:wrap;position:relative;z-index:70}
.ordr-landing .topbar .tag{font-size:11px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--green-deep);
 background:rgba(34,197,94,.11);border:1px solid rgba(34,197,94,.26);padding:4px 12px;border-radius:999px}
.ordr-landing .topbar a{color:var(--green-deep);font-weight:600}
/* ---------- nav ---------- */


.ordr-landing nav{position:sticky;top:0;z-index:60;background:rgba(255,254,252,.72);
 backdrop-filter:saturate(180%) blur(18px);-webkit-backdrop-filter:saturate(180%) blur(18px);
 border-bottom:1px solid var(--line-soft)}
.ordr-landing .nav-in{display:flex;align-items:center;justify-content:space-between;height:74px}
.ordr-landing .lg{height:34px;color:var(--ink);display:block}
.ordr-landing .lg svg{height:100%;width:auto;display:block}
.ordr-landing .nav-links{display:flex;align-items:center;gap:32px}
.ordr-landing .nav-links a:not(.btn){color:var(--ink-2);font-size:15.5px;font-weight:500;letter-spacing:-.008em}
.ordr-landing .nav-links a:not(.btn):hover{color:var(--ink)}
/* ---------- hero ---------- */


.ordr-landing .hero{position:relative;overflow:hidden;background:#fff;padding:54px 0 44px}
.ordr-landing .hero-in{position:relative;z-index:3;display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:36px;align-items:center}
.ordr-landing .pill{display:inline-flex;align-items:center;gap:9px;background:rgba(255,255,255,.82);
 border:1px solid rgba(7,16,11,.07);border-radius:999px;padding:7px 17px 7px 13px;font-size:13.5px;
 color:var(--ink-2);box-shadow:0 1px 2px rgba(7,16,11,.04);margin-bottom:22px}
.ordr-landing .pill .st{color:#F5A524;letter-spacing:1.4px;font-size:12.5px}
.ordr-landing .hero h1{margin-bottom:22px;max-width:600px}
.ordr-landing .hero .lede{max-width:34ch;margin-bottom:32px}
.ordr-landing .cta{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.ordr-landing .micro{font-size:13.5px;color:var(--ink-3);margin-top:20px}
.ordr-landing .stats{display:grid;grid-template-columns:repeat(2,1fr);gap:13px;margin-top:40px;max-width:392px}
.ordr-landing .stat{background:rgba(255,255,255,.76);border:1px solid rgba(255,255,255,.94);border-radius:19px;
 padding:17px 16px 16px;backdrop-filter:blur(10px);
 box-shadow:0 1px 2px rgba(7,16,11,.05),0 10px 30px rgba(7,16,11,.07),inset 0 1px 0 rgba(255,255,255,.95)}
.ordr-landing .stat b{display:block;font-size:31px;font-weight:700;letter-spacing:-.042em;line-height:1}
.ordr-landing .stat b.g{color:var(--green-deep)}
.ordr-landing .stat span{display:block;color:var(--ink-3);font-size:12px;margin-top:7px;line-height:1.3}
/* ---------- 3D phone ---------- */


.ordr-landing .stage{position:relative;height:640px;perspective:3200px;overflow:visible}
.ordr-landing .tilt{position:absolute;z-index:2;left:50px;top:0px;transform-origin:50% 50%;
 transform:rotate(8deg) rotateY(5deg) rotateX(1.5deg) scale(0.94);transform-style:preserve-3d}
.ordr-landing .iphone{position:relative;width:328px;height:668px;transform-style:preserve-3d;
 filter:drop-shadow(-16px 42px 46px rgba(7,16,11,.26))}
.ordr-landing .slab{position:absolute;inset:0;border-radius:58px;
 background:linear-gradient(158deg,#C3C9CD 0%,#8C9398 22%,#5A6165 48%,#A7AEB3 72%,#6C7378 100%);
 transform:translateZ(calc(var(--n) * -2px));filter:brightness(calc(1 - var(--n) * 0.026))}
.ordr-landing .face{position:absolute;inset:0;border-radius:58px;padding:3px;transform:translateZ(.5px);
 background:linear-gradient(145deg,#8E9499 0%,#EDEFF0 13%,#9AA1A6 29%,#5B6266 51%,#C9CED1 73%,#767D82 92%);
 box-shadow:0 0 0 .5px rgba(255,255,255,.26),inset 0 1px 1px rgba(255,255,255,.42)}
.ordr-landing .bezel{position:relative;width:100%;height:100%;border-radius:55px;background:#050907;padding:9px}
.ordr-landing .face::before,.ordr-landing .face::after{content:"";position:absolute;background:linear-gradient(180deg,#6F767B,#B9BFC3);
 border-radius:2px;transform:translateZ(-18px)}
.ordr-landing .face::before{left:-3px;top:162px;width:4px;height:68px;box-shadow:0 90px 0 #7B8287,0 -50px 0 #7B8287}
.ordr-landing .face::after{right:-3px;top:200px;width:4px;height:104px}
.ordr-landing .screen{width:100%;height:100%;border-radius:47px;overflow:hidden;background:#fff;position:relative;
 display:flex;flex-direction:column}
.ordr-landing .island{position:absolute;top:12px;left:50%;transform:translateX(-50%);width:96px;height:28px;background:#050907;border-radius:999px;z-index:9}
.ordr-landing .status{position:absolute;top:16px;left:0;right:0;z-index:8;display:flex;justify-content:space-between;
 padding:0 26px;font-size:12.5px;font-weight:600;color:#fff}
.ordr-landing .shot{height:232px;flex:none;position:relative;background-size:cover;background-position:center 46%}
.ordr-landing .shot::after{content:"";position:absolute;inset:0;background:linear-gradient(to top,rgba(0,0,0,.76),rgba(0,0,0,.10) 54%,rgba(0,0,0,.30))}
.ordr-landing .sname{position:absolute;left:0;right:0;bottom:14px;z-index:3;color:#fff;text-align:center}
.ordr-landing .sname b{display:block;font-size:19px;font-weight:700;letter-spacing:-.03em}
.ordr-landing .sname u{display:block;font-size:11px;color:#7EE3A6;font-weight:600;margin-top:5px}
.ordr-landing .sbody{flex:1;display:flex;flex-direction:column;padding:13px 15px 0;min-height:0}
.ordr-landing .seg{display:flex;gap:6px;margin-bottom:10px}
.ordr-landing .seg div{flex:1;text-align:center;font-size:12px;font-weight:600;padding:8px 0;border-radius:13px;color:var(--ink-3);background:#F4F3F0}
.ordr-landing .seg .on{background:#fff;color:var(--ink);box-shadow:0 1px 3px rgba(0,0,0,.12),0 0 0 1px rgba(7,16,11,.06)}
.ordr-landing .rwh{display:flex;align-items:center;margin-bottom:9px}
.ordr-landing .rwh b{font-size:13.5px;font-weight:700;letter-spacing:-.015em}
.ordr-landing .rwh span{margin-left:auto;font-size:11.5px;color:var(--green-deep);font-weight:600}
.ordr-landing .rw{display:flex;align-items:center;gap:10px}
.ordr-landing .dots{display:flex}
.ordr-landing .dots i{width:25px;height:25px;border-radius:8px;display:block;margin-left:-6px;border:2px solid #fff;
 background-size:cover;background-position:center;box-shadow:0 1px 3px rgba(7,16,11,.14)}
.ordr-landing .dots i:first-child{margin-left:0}
.ordr-landing .dots i.rw5{background:var(--green-mid);color:#fff;font-size:10px;font-weight:700;display:grid;place-items:center;letter-spacing:-.02em}
.ordr-landing .bar{flex:1}.ordr-landing .bar .t{height:4px;border-radius:999px;background:#EDEBE6;position:relative}
.ordr-landing .bar .t::after{content:"";position:absolute;left:0;top:0;bottom:0;width:42%;border-radius:999px;background:var(--green-mid)}
.ordr-landing .bar .t i{position:absolute;left:42%;top:50%;transform:translate(-50%,-50%);width:10px;height:10px;border-radius:50%;background:var(--green-mid);border:2px solid #fff}
.ordr-landing .bar .n2{display:flex;justify-content:space-between;font-size:10px;color:var(--ink-3);margin-top:5px}
.ordr-landing .menu{margin-top:9px;flex:1 1 auto;min-height:0;overflow:hidden}
.ordr-landing .mi{display:flex;align-items:center;gap:10px;padding:7px 0;border-bottom:1px solid rgba(7,16,11,.06)}
.ordr-landing .mi:last-child{border-bottom:0}
.ordr-landing .mi .th{width:36px;height:36px;border-radius:10px;flex:none;background-size:cover;background-position:center}
.ordr-landing .mi .nm2{flex:1;min-width:0}
.ordr-landing .mi .nm2 b{display:block;font-size:11.5px;font-weight:700;letter-spacing:-.012em;line-height:1.15;color:var(--ink)}
.ordr-landing .mi .nm2 span{display:block;font-size:9.5px;color:#5D6B64;margin-top:2px}
.ordr-landing .mi .pr{margin-left:auto;flex:none;font-size:11.5px;font-weight:700}
.ordr-landing .cofoot{flex:0 0 auto;padding:10px 0 15px}
.ordr-landing .ptsline{text-align:center;color:var(--green-mid);font-size:13px;font-weight:700;margin-bottom:7px}
.ordr-landing .cobar{border-radius:15px;background:#0B1220;display:flex;align-items:center;padding:11px 13px;gap:10px}
.ordr-landing .cobar .l b{display:block;color:#fff;font-size:12px;font-weight:700;letter-spacing:.05em;line-height:1}
.ordr-landing .cobar .l span{display:block;color:rgba(255,255,255,.72);font-size:11.5px;margin-top:4px;line-height:1}
.ordr-landing .cobar .cnt{margin-left:auto;width:27px;height:27px;border-radius:50%;background:var(--green-mid);color:#fff;
 font-size:12px;font-weight:700;display:grid;place-items:center;flex:none}
/* ---------- incoming orders ---------- */


.ordr-landing .orders{position:absolute;left:-140px;bottom:300px;width:236px;z-index:1;
 display:flex;flex-direction:column-reverse;align-items:flex-end;gap:11px;pointer-events:none}
.ordr-landing .ord{display:inline-flex;width:auto;align-items:center;gap:11px;background:rgba(255,255,255,.94);
 border:1px solid rgba(7,16,11,.07);border-radius:16px;padding:11px 26px 11px 15px;
 backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
 box-shadow:0 1px 2px rgba(7,16,11,.05),0 14px 34px rgba(7,16,11,.13),inset 0 1px 0 rgba(255,255,255,.9);
 animation:ordr-ordIn .52s cubic-bezier(.16,.84,.34,1) both}
.ordr-landing .ord .dot{width:26px;height:26px;border-radius:50%;background:rgba(34,197,94,.13);flex:none;
 display:grid;place-items:center}
.ordr-landing .ord .dot svg{width:14px;height:14px;stroke:var(--green-deep);fill:none;stroke-width:2.6;stroke-linecap:round;stroke-linejoin:round}
.ordr-landing .ord b{font-size:19px;font-weight:700;letter-spacing:-.03em;color:var(--ink);line-height:1}
.ordr-landing .ord.out{animation:ordr-ordOut .45s ease forwards}
/* the phone's 8deg lean already slopes its edge ~9px per row, so a uniform
   offset lands the top pill flush and the newest one tucked behind */

@keyframes ordr-fadeInScale{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
@keyframes ordr-ordIn{from{opacity:0;transform:translateY(26px) scale(.90)}to{opacity:1;transform:none}}
@keyframes ordr-ordOut{to{opacity:0;transform:translateY(-18px) scale(.96)}}
@media(prefers-reduced-motion:reduce){.ordr-landing .ord{animation:none}}
@media(max-width:1000px) and (min-width:761px){.ordr-landing .orders{display:none}}
/* ---------- marquee ---------- */


.ordr-landing .marq{position:relative;z-index:3;background:rgba(255,255,255,.6);backdrop-filter:blur(18px);
 border-top:1px solid var(--line-soft);border-bottom:1px solid var(--line-soft);padding:20px 0 24px;overflow:hidden}
.ordr-landing .marq-l{text-align:center;font-size:11.5px;letter-spacing:.13em;text-transform:uppercase;color:var(--ink-3);margin-bottom:13px}
.ordr-landing .track{display:flex;gap:56px;animation:ordr-slide 38s linear infinite;width:max-content}
@keyframes ordr-slide{to{transform:translateX(-50%)}}
.ordr-landing .track span{font-size:20px;font-weight:600;color:rgba(7,16,11,.24);letter-spacing:-.022em;white-space:nowrap}
@media(prefers-reduced-motion:reduce){.ordr-landing .track{animation:none}}
/* ---------- sections ---------- */


.ordr-landing section{padding:116px 0}
.ordr-landing .sec-head{max-width:680px;margin-bottom:56px}
.ordr-landing .sec-head .eyebrow{display:block;margin-bottom:15px}
.ordr-landing .sec-head .h2{margin-bottom:18px}
.ordr-landing .sec-head p{font-size:17.5px;color:var(--ink-2);line-height:1.6;max-width:60ch}

.ordr-landing .tiles{display:grid;grid-template-columns:1fr 1fr;gap:20px}
.ordr-landing .t2{border:1px solid var(--line);border-radius:26px;overflow:hidden;background:#fff;display:flex;flex-direction:column;
 box-shadow:0 1px 2px rgba(7,16,11,.04),0 14px 40px rgba(7,16,11,.06)}
.ordr-landing .t2 .top{background:#fff;padding:28px 30px 26px;display:flex;align-items:flex-start;gap:16px;min-height:126px}
.ordr-landing .t2 .top h3{flex:1;margin-top:16px}
.ordr-landing .t2 .vis{flex:none;display:flex;align-items:flex-start;gap:10px;margin-right:-6px;margin-top:-2px}
.ordr-landing .t2 .bot{position:relative;margin-top:auto;padding:22px 30px 24px;border-top:1px solid var(--line-soft)}
.ordr-landing .t2 .bot p{position:relative;z-index:2;font-size:16px;line-height:1.5;color:var(--ink);font-weight:500}
.ordr-landing .mkbare{display:inline-flex;align-items:center}
.ordr-landing .mkbare svg,.ordr-landing .mkbare img{height:42px;width:auto;display:block}
.ordr-landing .mkbox{height:42px;border:1px solid var(--line);border-radius:11px;background:#fff;display:inline-flex;
 align-items:center;justify-content:center;padding:0 15px}
.ordr-landing .mkbox svg,.ordr-landing .mkbox img{height:15px;width:auto;display:block}
.ordr-landing .srank{display:flex;flex-direction:column;gap:8px;width:186px}
.ordr-landing .sr{display:flex;align-items:center;gap:9px;border:1px solid var(--line);border-radius:12px;padding:9px 12px;background:#fff}
.ordr-landing .sr .fav{width:17px;height:17px;border-radius:5px;background:#C7CCC9;flex:none}
.ordr-landing .sr .ln{flex:1}
.ordr-landing .sr .ln i{display:block;height:4.5px;border-radius:2px;background:rgba(7,16,11,.20)}
.ordr-landing .sr.on{border-color:rgba(22,163,74,.42);box-shadow:0 2px 10px rgba(22,163,74,.16)}
.ordr-landing .sr.on .fav{background:var(--green-mid)}
.ordr-landing .sr.on .ln b{display:block;font-size:11.5px;font-weight:700;letter-spacing:-.01em}
.ordr-landing .sr.on .ln i{background:rgba(22,163,74,.34);margin-top:5px;width:72%}
.ordr-landing .sr.off{opacity:.40}
.ordr-landing .sr.off .ln i{width:78%}
.ordr-landing .sr.off .ln i+i{margin-top:5px;width:52%}
.ordr-landing .lylt{width:170px}
.ordr-landing .lylt .ptsline{font-size:13px;margin-bottom:6px}
.ordr-landing .lylt .cobar{padding:9px 11px;border-radius:13px}
.ordr-landing .lylt .cobar .l b{font-size:11px}.ordr-landing .lylt .cobar .l span{font-size:11px}
.ordr-landing .lylt .cobar .cnt{width:23px;height:23px;font-size:11px}
/* ---------- table ---------- */


.ordr-landing .tblwrap{border:1px solid rgba(7,16,11,.13);border-radius:22px;overflow:hidden;background:#fff;
 box-shadow:0 1px 2px rgba(7,16,11,.04),0 14px 40px rgba(7,16,11,.06)}
.ordr-landing .tblcap{padding:16px 22px;background:var(--ink);display:flex;align-items:baseline;gap:12px;flex-wrap:wrap}
.ordr-landing .tblcap b{font-size:19px;font-weight:700;letter-spacing:-.025em;color:#fff}
.ordr-landing .tblcap span{font-size:14px;color:rgba(255,255,255,.66)}
.ordr-landing .tblbody{position:relative}
.ordr-landing .ocol{position:absolute;top:0;bottom:0;right:0;width:15.5%;z-index:0;background:var(--ink)}
.ordr-landing table{width:100%;border-collapse:collapse;font-size:15.5px;position:relative;z-index:1}
.ordr-landing th,.ordr-landing td{padding:15px 12px;text-align:center;border-right:1px solid rgba(7,16,11,.10);border-bottom:1px solid rgba(7,16,11,.10)}
.ordr-landing th:last-child,.ordr-landing td:last-child{border-right:0}
.ordr-landing tbody tr:last-child td{border-bottom:0;padding-bottom:20px}
.ordr-landing th{font-size:14.5px;font-weight:700;color:var(--ink-2);background:#FAFAF8}
.ordr-landing td:first-child,.ordr-landing th:first-child{text-align:left;color:var(--ink-2);font-weight:600;padding-left:22px}
.ordr-landing tbody td{font-weight:700;color:var(--ink)}
.ordr-landing th.oc,.ordr-landing td.oc{background:transparent;position:relative;color:#fff!important;border-bottom-color:rgba(255,255,255,.16)}
.ordr-landing tbody tr:last-child td.oc{border-bottom:0}
.ordr-landing .oc span{position:relative;z-index:2}
.ordr-landing .oclogo{height:22px;display:block;margin:0 auto}
.ordr-landing .oclogo svg{height:100%;width:auto;display:block;margin:0 auto}
.ordr-landing .bad{color:#C0392B}
.ordr-landing td.ul{position:relative}
.ordr-landing .uw{position:relative;display:inline-block}
.ordr-landing .scrib{position:absolute;left:50%;transform:translateX(-50%);bottom:-13px;width:132%;height:17px;
 overflow:visible;pointer-events:none;z-index:4}
.ordr-landing .scrib.long{width:100%;transform:translateX(-52%);bottom:3px}

.ordr-landing .soonstrip{display:flex;align-items:center;gap:16px;margin-top:18px;padding:16px 22px;border-radius:18px;
 border:1px dashed rgba(7,16,11,.16);background:#F7F7F5;flex-wrap:wrap}
.ordr-landing .soonstrip .bd{font-size:10.5px;font-weight:700;letter-spacing:.11em;text-transform:uppercase;color:var(--ink-3);
 border:1px solid rgba(7,16,11,.16);padding:5px 11px;border-radius:999px;flex:none}
.ordr-landing .soonstrip p{font-size:15px;color:var(--ink-2);line-height:1.4;flex:1;min-width:260px}
.ordr-landing .soonstrip .lbls{display:flex;gap:8px;flex:none}
.ordr-landing .soonstrip .lb{height:30px;padding:0 12px;border-radius:8px;border:1px dashed rgba(7,16,11,.24);
 font-size:12px;font-weight:700;color:var(--ink-3);display:inline-flex;align-items:center;background:#fff}
/* ---------- mobile comparison switcher ---------- */


.ordr-landing .cmp{display:none}
@media(max-width:760px){
 .ordr-landing .tblwrap{display:none}
 .ordr-landing .cmp{display:block;border:1px solid rgba(7,16,11,.13);border-radius:22px;overflow:hidden;background:#fff;
  box-shadow:0 1px 2px rgba(7,16,11,.04),0 14px 40px rgba(7,16,11,.06)}
 .ordr-landing .cmp-cap{padding:14px 16px;background:var(--ink)}
 .ordr-landing .cmp-cap b{display:block;font-size:16px;font-weight:700;letter-spacing:-.022em;color:#fff}
 .ordr-landing .cmp-cap span{display:block;font-size:11.5px;color:rgba(255,255,255,.62);margin-top:4px}
 .ordr-landing .cmp-grid{display:grid;grid-template-columns:1fr 92px 1fr}
 .ordr-landing .cmp-grid>div{padding:13px 10px;text-align:center;font-size:13px;font-weight:700;color:var(--ink);
  border-bottom:1px solid rgba(7,16,11,.10);display:flex;align-items:center;justify-content:center;min-height:52px}
 .ordr-landing .cmp-grid>div.lbl{text-align:left;justify-content:flex-start;font-size:12px;font-weight:600;color:var(--ink-2);padding-left:15px}
 .ordr-landing .cmp-grid>div.oc2{background:var(--ink);color:#fff;border-bottom-color:rgba(255,255,255,.16);position:relative}
 .ordr-landing .cmp-grid>div.hd{background:#FAFAF8;font-size:12px;font-weight:700;color:var(--ink-2);min-height:56px}
 .ordr-landing .cmp-grid>div.hd.oc2{background:var(--ink);color:#fff}
 .ordr-landing .cmp-grid>div:nth-last-child(-n+3){border-bottom:0}
 .ordr-landing .cmp-grid .bad{color:#C0392B}
 .ordr-landing .oclogo2{height:17px}
 .ordr-landing .oclogo2 svg{height:100%;width:auto;display:block}
 .ordr-landing .nav-cmp{display:flex;align-items:center;justify-content:space-between;gap:6px;width:100%}
 .ordr-landing .nav-cmp button{position:relative;width:36px;height:36px;border-radius:50%;border:1px solid rgba(7,16,11,.14);
  background:#fff;display:grid;place-items:center;cursor:pointer;flex:none;padding:0;-webkit-tap-highlight-color:transparent}
/* visual stays 30px; tappable area expands to 48px */
 
 .ordr-landing .nav-cmp button::after{content:"";position:absolute;inset:-9px}
 .ordr-landing .nav-cmp button:active{background:#F1F0EC}
 .ordr-landing .nav-cmp svg{width:15px;height:15px;stroke:var(--ink-2);fill:none;stroke-width:2.4;stroke-linecap:round;stroke-linejoin:round}
 .ordr-landing .nav-cmp .who2{flex:1;font-size:12.5px;font-weight:700;color:var(--ink-2);letter-spacing:-.01em}
 .ordr-landing .cmp-dots{display:flex;justify-content:center;gap:6px;padding:12px 0 14px;background:#fff}
 .ordr-landing .cmp-dots i{width:6px;height:6px;border-radius:50%;background:rgba(7,16,11,.18);display:block;transition:background .2s}
 .ordr-landing .cmp-dots i.on{background:var(--green-mid)}
}
/* ---------- references ---------- */


.ordr-landing .refs{position:relative;overflow:hidden;border-radius:30px;background:#050907;padding:84px 56px;margin-bottom:26px}
.ordr-landing .refs .plasma{opacity:.8}
.ordr-landing .refs .blob{filter:blur(70px)}
.ordr-landing .refs .grain{opacity:.15;mix-blend-mode:normal}
.ordr-landing .refs .eyebrow{position:relative;z-index:3;display:block;color:#7EE3A6;margin-bottom:20px}
.ordr-landing .refs h2{position:relative;z-index:3;color:#fff;font-size:clamp(32px,4.6vw,60px);line-height:1.04;
 letter-spacing:-.042em;font-weight:700;max-width:19ch;margin-bottom:24px}
.ordr-landing .refs h2 .gr{color:#7EE3A6}
.ordr-landing .refs p{position:relative;z-index:3;color:rgba(255,255,255,.72);font-size:clamp(17px,1.5vw,21px);
 line-height:1.5;max-width:52ch}
/* ---------- founder ---------- */


.ordr-landing .founder{position:relative;overflow:hidden;background:#fff;border:1px solid var(--line);border-radius:30px;
 padding:52px 56px;box-shadow:0 1px 2px rgba(7,16,11,.04),0 18px 50px rgba(7,16,11,.07)}
.ordr-landing .founder .q{position:relative;z-index:2;font-size:clamp(22px,2.3vw,30px);line-height:1.4;letter-spacing:-.024em;
 font-weight:500;max-width:30ch}
.ordr-landing .founder .q b{font-weight:700}
.ordr-landing .byline{position:relative;z-index:2;display:flex;align-items:flex-start;gap:34px;margin-top:26px}
.ordr-landing .byline .nm{font-size:15px;color:var(--ink-3)}
.ordr-landing .autograph{display:block;height:64px;width:auto;flex:none;opacity:.92}
/* ---------- final ---------- */


.ordr-landing .final{position:relative;overflow:hidden;background:#050907;border-radius:36px;padding:92px 48px;text-align:center}
.ordr-landing .final .plasma{opacity:.85}
.ordr-landing .final .blob{filter:blur(66px)}
.ordr-landing .final .grain{opacity:.16;mix-blend-mode:normal}
.ordr-landing .final .display{color:#fff;position:relative;z-index:3;margin-bottom:20px;font-size:clamp(32px,4.2vw,50px);max-width:none}
.ordr-landing .final .display .gr{color:#7EE3A6}
.ordr-landing .final p{color:rgba(255,255,255,.68);position:relative;z-index:3;max-width:46ch;margin:0 auto 34px;font-size:18px}
.ordr-landing .final .cta{justify-content:center;position:relative;z-index:3}

.ordr-landing footer{border-top:1px solid var(--line-soft);padding:48px 0 66px;margin-top:110px}
.ordr-landing .foot{display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:22px}
.ordr-landing .foot-links{display:flex;gap:28px}
.ordr-landing .foot-links a{color:var(--ink-3);font-size:14.5px}
.ordr-landing .copy{color:var(--ink-3);font-size:14px}

@media(max-width:760px){
 .ordr-landing .wrap{padding:0 22px}
/* announcement: was wrapping to 3 lines = 148px tall */
 
 .ordr-landing .topbar{padding:9px 16px;font-size:12.5px;gap:8px;line-height:1.35}
 .ordr-landing .topbar .tag{font-size:9.5px;padding:3px 9px}
 .ordr-landing .nav-links a:not(.btn){display:none}
 .ordr-landing .nav-in{height:58px}
 .ordr-landing .lg{height:28px}
 .ordr-landing .btn-sm{height:36px;padding:0 15px;font-size:13.5px}
/* hero: compress everything above the phone */

 
 .ordr-landing .hero{padding:22px 0 0}
 .ordr-landing .hero .plasma{opacity:.40}
 .ordr-landing .hero .grain{opacity:.2}
 .ordr-landing .pill{padding:5px 13px 5px 10px;font-size:12px;margin-bottom:14px}
 .ordr-landing .pill .st{font-size:11px}
 .ordr-landing .hero h1{font-size:34px;line-height:1.06;margin-bottom:14px;max-width:none}
 .ordr-landing .hero .lede{font-size:16px;line-height:1.5;margin-bottom:18px;max-width:none}
 .ordr-landing .cta{gap:9px;flex-wrap:nowrap}
 .ordr-landing .cta .btn{flex:1;height:46px;padding:0 14px;font-size:14.5px;justify-content:center}
 .ordr-landing .micro{display:none}
 .ordr-landing .stats{grid-template-columns:1fr 1fr;gap:9px;margin-top:16px;max-width:none}
 .ordr-landing .stat{padding:12px 13px 11px;border-radius:15px}
 .ordr-landing .stat b{font-size:24px}
 .ordr-landing .stat span{font-size:11px;margin-top:5px}
/* phone bleeds off the right, orders stack on the left */

 
 .ordr-landing .hero-in{gap:0}
 .ordr-landing .stage{height:400px;margin:8px -22px 0;overflow:hidden}
 .ordr-landing .tilt{left:auto;right:-96px;top:4px;
   transform:rotate(8deg) rotateY(5deg) rotateX(1.5deg) scale(.74)}
 .ordr-landing .orders{display:flex;left:32px;right:auto;top:auto;bottom:275px;width:auto;align-items:flex-start;gap:7px}
 .ordr-landing .ord{padding:8px 15px 8px 10px;border-radius:13px;gap:8px}
 .ordr-landing .ord .dot{width:19px;height:19px}
 .ordr-landing .ord .dot svg{width:10px;height:10px}
 .ordr-landing .ord b{font-size:15px}
/* tiles: title and visual stack instead of fighting for one row */

 
 .ordr-landing .t2 .top{flex-direction:column;align-items:flex-start;gap:16px;min-height:0;padding:22px 22px 18px}
 .ordr-landing .t2 .top h3{margin-top:0;font-size:20px}
 .ordr-landing .t2 .vis{margin:0}
 .ordr-landing .t2 .bot{padding:18px 22px 20px}
 .ordr-landing .t2 .bot p{font-size:15px}
 .ordr-landing .tiles{gap:14px}
 .ordr-landing .sec-head{margin-bottom:30px}
 .ordr-landing .sec-head p{font-size:16px}
 .ordr-landing section{padding:64px 0}
 .ordr-landing .refs{padding:44px 24px}
 .ordr-landing .founder{padding:32px 24px}
 .ordr-landing .founder .q{font-size:21px}
 .ordr-landing .autograph{height:52px}
/* comparison table: fit all six columns rather than clip the Ordr column */

 
 .ordr-landing .tblcap{padding:12px 14px}
 .ordr-landing .tblcap b{font-size:15px}
 .ordr-landing .tblcap span{font-size:11.5px}
 .ordr-landing table{font-size:12px;table-layout:auto;width:100%}
 .ordr-landing th,.ordr-landing td{overflow-wrap:normal;word-break:normal;hyphens:none}
 .ordr-landing tbody td{white-space:nowrap;font-size:12px}
 .ordr-landing th{white-space:nowrap;font-size:11px;letter-spacing:-.01em}
/* 6 columns can't be legible at 390px — show the two most relevant rivals */
 
 .ordr-landing th:nth-child(3),.ordr-landing td:nth-child(3),.ordr-landing th:nth-child(4),.ordr-landing td:nth-child(4){display:none}
 .ordr-landing col:nth-child(3),.ordr-landing col:nth-child(4){display:none}
 .ordr-landing td:first-child,.ordr-landing th:first-child{white-space:normal;font-size:11.5px;padding-left:11px;line-height:1.25}
 .ordr-landing th,.ordr-landing td{padding:11px 4px}
 .ordr-landing th{font-size:9.5px}
 .ordr-landing td:first-child,.ordr-landing th:first-child{padding-left:9px;font-size:10px}
 .ordr-landing .oclogo{height:14px}
 .ordr-landing .scrib{height:12px;bottom:-9px}
 .ordr-landing .soonstrip{padding:13px 15px;gap:11px}
 .ordr-landing .soonstrip p{font-size:13px;min-width:0}
 .ordr-landing .soonstrip .lbls{width:100%}
 .ordr-landing .soonstrip .lb{height:26px;padding:0 9px;font-size:10.5px}
 .ordr-landing .foot-links{flex-wrap:wrap;gap:16px 20px}
 .ordr-landing .foot{gap:18px}
}
@media(max-width:1000px){
 .ordr-landing .hero-in{grid-template-columns:1fr;gap:0}
 .ordr-landing .hero h1{max-width:none}
 .ordr-landing .stage{height:470px;margin:-46px -32px 0}
 .ordr-landing .tilt{left:50%;transform:translateX(-48%) rotate(8deg) rotateY(5deg) rotateX(1.5deg) scale(.76)}
 .ordr-landing .stats{grid-template-columns:1fr 1fr;max-width:none}
 .ordr-landing .tiles{grid-template-columns:1fr}
 .ordr-landing section{padding:84px 0}
 .ordr-landing .founder{padding:36px 28px}
 .ordr-landing .refs{padding:48px 26px;border-radius:24px}
 .ordr-landing .byline{flex-direction:column;gap:12px}
 .ordr-landing .final{padding:60px 26px;border-radius:28px}
 .ordr-landing table{font-size:13px}
 .ordr-landing th,.ordr-landing td{padding:11px 7px}
 .ordr-landing td:first-child,.ordr-landing th:first-child{padding-left:14px}
}
`

// The wordmark appears in the nav, the comparison table header (desktop and
// mobile) and the footer. fill="currentColor" is what lets the same markup read
// dark on the nav and white inside the near-black Ordr column.
function OrdrLogo() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 5893.7 2352.3">
      <g transform="translate(39.581,203.962) scale(9.39321,9.39321)"><path d="M187.03 112 A77.5 77.5 0 1 0 36.17 112 C44.21 146.06 79.24 171.84 111.5 191 C143.96 171.84 178.99 146.06 187.03 112 Z M147.9 94.1 A36.3 36.3 0 1 0 75.3 94.1 A36.3 36.3 0 1 0 147.9 94.1 Z" fill="currentColor" fillRule="evenodd"/></g>
      <g transform="translate(2114.221,547.909) scale(1.00000,1.00000)"><path d="M545.5 31.65c-20.35 1.7-40.55 4-51.75 5.9-26.7 4.45-27.25 4.55-43.25 8.5-2.75.65-7 1.55-9.5 2-2.45.4-5.6 1.2-7 1.75-1.35.55-5.4 1.75-9 2.7a301 301 0 0 0-27 8.45c-1.9.65-4.85 1.6-6.5 2.05-4.75 1.3-21.85 8.05-26.85 10.55-1.55.8-3.2 1.45-3.7 1.45-1.6 0-29.85 13.55-45.45 21.85a507 507 0 0 0-24.35 14.4c-1.45.95-3.3 2.05-4.15 2.45-.8.35-4.4 2.7-8 5.15-3.55 2.45-8.5 5.85-11 7.5-39.3 26.5-81.85 67.8-115.4 112.05-23.5 30.95-49.5 75.3-64.2 109.35-.75 1.8-2.05 4.8-2.9 6.75-3.55 8.35-4.85 11.15-6.1 13.85-.8 1.55-1.4 3.4-1.4 4.15s-.65 2.6-1.4 4.15c-.8 1.6-2.1 4.65-2.9 6.85s-2.15 5.8-3 8c-1.65 4.35-10.15 31.2-12.2 38.5-.7 2.45-2.05 7.4-3 11-.95 3.55-2.35 8.5-3.1 10.95-.8 2.4-1.4 5.3-1.4 6.4s-.65 4.25-1.45 7.05c-1.5 5.35-3.6 15.1-5.95 27.6-14.5 77.55-16.65 162.15-6 241 3 22.3 9.05 54.4 12 63.95.8 2.4 1.4 5.35 1.4 6.55s.6 4.15 1.35 6.55c.8 2.45 2.15 7.15 3.05 10.45C59.3 835.6 67.8 862 72 873c3.95 10.35 5.1 13.5 5.9 16.05.45 1.4 2.05 5.2 3.5 8.5a854 854 0 0 1 7 15.7c2.65 6 17.3 35.2 19.45 38.75a58 58 0 0 1 2.8 5c1.3 2.9 15.7 26.55 20.95 34.5 43 64.75 99.1 118.75 164.2 157.9 18.65 11.2 60.8 32.6 64.3 32.6.6 0 2.3.65 3.75 1.4s4.7 2.15 7.15 3.1c2.5.9 5.85 2.3 7.5 3.05 5.55 2.55 31.75 11.2 40.5 13.45 1.95.5 6.65 1.8 10.5 2.95s8.8 2.45 11 2.95l13.5 3.1c11.3 2.6 22.45 4.8 30 5.9 3.05.5 8.65 1.35 12.5 1.95 54.2 8.55 112.25 9.4 172.5 2.6 22.8-2.6 53.05-8 67.6-12.05 2.8-.75 5.9-1.4 6.95-1.4s3.7-.65 5.9-1.4c2.25-.75 7-2.15 10.55-3.1a301 301 0 0 0 27-8.45c1.95-.65 4.85-1.6 6.5-2a59 59 0 0 0 5.5-1.8c1.4-.55 4.55-1.8 7-2.75 2.5-.95 5.85-2.35 7.5-3.05s5.05-2.05 7.5-3c2.5-.95 7.45-3.05 11-4.7 3.6-1.65 9.45-4.35 13-5.95 3.6-1.65 7.2-3.35 8-3.8.85-.5 4.9-2.55 9-4.65 17.2-8.7 49.5-28.8 66.5-41.4 42.15-31.2 86.8-76.8 113.9-116.3 8.3-12.05 13.05-19.05 14.1-20.85l9.1-15c4.4-7.3 8.35-14 8.75-14.8.35-.85 1.65-3.1 2.8-5 1.2-1.95 4.75-8.7 7.9-15 6.55-13.2 10-20.6 17.4-37.5.7-1.65 2.05-5.05 3-7.5.95-2.5 2.3-5.85 3-7.5s2.1-5.05 3.05-7.5c.9-2.5 2.35-6 3.1-7.8s1.4-3.9 1.4-4.7.6-2.9 1.35-4.7c1.7-4 3.5-9.25 4.7-13.3.45-1.65 1.8-6.15 2.95-10s2.5-8.6 3-10.5c.5-1.95 1.95-7.55 3.25-12.5 29.25-110.5 29.65-245.35 1.1-359-4.75-19-4.95-19.75-11.9-42-4.55-14.6-5.45-17.4-8.85-26.25-.85-2.35-2.25-5.95-3-8-7.4-19.7-21.85-51.2-31.55-68.75-1.85-3.3-4.45-8.05-5.8-10.5-2.05-3.7-9.1-15.6-14.55-24.45-1.1-1.75-3.75-5.7-13.05-19.55-13.9-20.55-38.6-50-59.65-71-18.4-18.4-30.5-28.9-56.1-48.65-5.75-4.45-24.85-17.4-32.5-22.05-2.5-1.55-5.75-3.6-7.25-4.55a34 34 0 0 0-4.15-2.4c-.8-.4-3.1-1.7-5.05-2.9-9.8-6.1-32.15-17.35-50.95-25.6-11.4-5-11.3-4.95-25-10.2-10.7-4.1-41.3-13.8-53.5-17-5.6-1.45-9.3-2.35-25.75-6.1-3.45-.75-10.5-2.15-15.75-3.05-5.2-.9-12.8-2.3-16.8-3.05-4-.8-8.7-1.45-10.5-1.45-1.75 0-7.9-.65-13.7-1.45-31.9-4.5-87.45-5.8-121.5-2.9m67.5 210.4c32.45 2 65.5 8.6 89.15 17.8 13.75 5.35 19.55 7.9 29.85 13.1 21.8 11 41.75 25.35 61.35 44.15 12 11.5 28.1 30.1 35.3 40.75 13.45 20 27.95 45.75 33.55 59.65 10.15 25.2 12.55 31.65 15.3 41 .95 3.3 2.35 7.8 3.05 10 2.75 8.8 6 21.4 7.5 29 .4 2.2 1.9 9.6 3.3 16.5 9.4 46.7 13.4 112.6 9.7 160.5-1.55 20.2-4.75 47.95-6.05 52.5-.55 1.9-1 5-1 6.85 0 3.25-1.95 13.3-4.25 21.65-.6 2.2-1.4 5.8-1.8 8-1.45 8.2-4.95 20.65-12.15 43-3 9.3-7.95 22-10.4 26.65-.75 1.45-1.4 3.25-1.4 4 0 1.2-6.85 15.05-15.65 31.85-7.4 14.05-22.2 35.35-35.95 51.75-7.95 9.45-31.15 31.45-41.4 39.2-18.3 13.9-41.05 26.75-61 34.5-2.45 1-5.55 2.2-6.85 2.7-8.35 3.25-30.55 9.65-41.15 11.85-17.5 3.65-51 6.95-70.45 7-32.6.05-80.95-7.5-100.35-15.6-1.8-.8-3.9-1.4-4.7-1.4s-3.15-.75-5.2-1.65c-2.1-.9-4.7-1.95-5.8-2.4-7.65-2.95-29.85-13.75-35-17a74 74 0 0 0-5-2.95c-4.9-2.55-22.45-14.8-29.5-20.7-24.1-20.05-52.85-54.3-67-79.8-2.9-5.3-12.65-23.75-13.95-26.4-4.75-9.9-13.05-30.85-16.1-40.6-1.75-5.5-3.75-11.6-4.45-13.5-1.8-5-4.2-13.35-6.05-21.5-.85-3.85-2.2-9.5-2.95-12.5-3.15-12.55-4.5-19.1-4.5-21.9 0-1.65-.6-5.8-1.4-9.3-1.35-6.35-3.5-23.4-5.65-44.8-1.75-17.7-2.35-68.2-1.05-86 .65-8.55 1.6-21.15 2.05-28.05.5-6.85 1.4-15.4 1.95-19 .55-3.55 1.75-11.2 2.6-16.95 2-13.2 4.1-24.65 6.1-33 .85-3.6 2.2-9.45 3-13 1.45-6.55 3.55-14.1 5.85-21.5.7-2.2 2.1-6.7 3.05-10 2.2-7.5 5.9-17.65 9.05-25 .7-1.65 2.7-6.6 4.45-11s3.8-9.15 4.5-10.55c.75-1.35 4.2-8.1 7.7-15 3.5-6.85 8.15-15.15 10.35-18.45 2.15-3.3 4.15-6.45 4.45-7 2.8-5.55 11.9-17.9 25.15-34.1 6.65-8.1 26.6-27.7 35.85-35.15 6.4-5.15 20.65-15.25 21.45-15.25.25 0 2.4-1.3 4.75-2.85 9.15-6.1 26.5-14.85 38.8-19.6 2.5-.95 5.85-2.3 7.5-3.05 3.3-1.45 19.5-6.35 29-8.8 30-7.75 67.1-10.85 102.5-8.65m1877-183.8c0 .7-.1 94.4-.25 208.25-.3 234.95.65 213.9-8.75 200-14.45-21.45-37.8-45.4-57.5-59.1-10.95-7.6-16.2-11.1-17.5-11.7-.8-.4-2.85-1.6-4.5-2.65-2.95-1.95-27.15-14.1-33-16.6-1.65-.7-5-2.05-7.5-2.95a94 94 0 0 1-7.15-3.1c-1.45-.75-3.35-1.4-4.2-1.4-.9 0-3.05-.6-4.85-1.4-4.75-1.95-18.3-5.7-32.8-9-48.15-10.9-109.35-9.85-160 2.85-14.75 3.7-18.75 4.85-21.8 6.15-1.8.75-3.85 1.4-4.6 1.4-1.2 0-5.85 1.7-21.1 7.7-56.05 22.15-108.65 64.35-145.55 116.8-10.45 14.85-14.95 21.5-14.95 22 0 .45-8.05 14.55-10 17.5-1.15 1.75-11.85 23.5-14.75 30-1.1 2.45-3.15 7-4.6 10.05-2.6 5.75-4.05 9.55-8.15 21.45a452 452 0 0 1-4.5 12.5c-2 5.25-4.25 12.55-5.55 18-.3 1.35-1.2 4.75-1.95 7.5-3.35 12.2-4.4 16.45-5.85 23-3.2 14.45-4.65 22.05-4.65 24 0 1.1-.65 5.15-1.45 9-1.5 7.2-3.55 24.2-5.7 47-1.55 16.5-1.6 72.1 0 88.5 2.25 24 4.25 41.55 5.65 49.5.75 4.4 2.15 12.25 3.05 17.5 1.95 11.3 4.1 21.65 5.95 28.5 3.3 12.2 3.85 14.2 4.55 17.5 1.25 6.1 3.75 14.15 7.45 24.5 2 5.5 4 11.35 4.45 13 1.85 6.35 3.45 10.5 9 22.75 1.7 3.7 3.05 7 3.05 7.25 0 .5 4.85 11.3 8.1 18 1.05 2.2 3.45 6.7 5.35 10 1.85 3.3 4.4 7.8 5.6 10 6.25 11.4 8.25 14.85 12.25 20.65 2.4 3.5 6.95 10.15 10.15 14.85 12.9 18.75 32 40.1 55.05 61.45 5.6 5.2 29.75 23.35 37.3 28.1 3.45 2.2 7.5 4.7 9 5.65 10.05 6.3 33.05 17.65 45.2 22.25 2.5.95 5.85 2.35 7.5 3.05 1.65.75 5.5 2.1 8.5 3.05 3.05.95 7.1 2.3 9 3 1.95.65 6.45 2 10 2.95 3.6.9 8.75 2.25 11.5 3.05 40.95 11.15 106.6 13.65 153.5 5.85 19.6-3.25 41.55-8.55 49.8-12 1.8-.8 3.9-1.4 4.7-1.4s3.15-.75 5.2-1.65c2.1-.9 5.25-2.25 7.05-3 11.55-4.8 22.95-10.3 30.75-14.85 3.3-1.9 6.7-3.8 7.5-4.15.85-.4 4.95-3.1 9.15-6 27.75-19.05 50.65-42.2 68.2-69.1 6.55-10 8.8-11.95 10.05-8.6.35.9.6 24.35.55 52.15 0 27.75.35 50.9.8 51.35s49 .75 107.8.6l106.95-.25V57.5l-113.25-.25c-90.25-.2-113.25 0-113.25 1m-160.65 465.8c10.9 1.6 22.65 3.95 27.65 5.5 27.6 8.6 41.85 15.8 59.5 30.05 15.55 12.6 33.9 33.8 40.5 46.9.55 1.1 1.9 3.35 3 5s2.4 4.05 2.95 5.3c.6 1.25 2.75 5.95 4.9 10.5 2.1 4.5 4.65 10.2 5.6 12.7 1 2.45 2.2 5.6 2.75 6.95 1.9 4.95 5.6 16.95 9.25 30.3 4.7 17.15 9.25 47.75 10.6 71.25 3.15 54.05-.5 102.25-11.1 146.9-1.2 4.95-2.5 9.9-2.9 11-.45 1.15-1.55 4.8-2.55 8.1-2.05 7.2-4.2 13.05-6.1 16.65-.75 1.45-1.4 3.2-1.4 3.85 0 1.1-11.5 24.75-14.35 29.5-12 20.15-27.75 38.05-44.65 50.9-5.2 4-10.15 7.55-11 7.9-.8.4-2.4 1.25-3.45 1.95-5.95 3.8-10 5.85-18.05 9.2-4.95 2.05-9.9 4.15-11 4.65-2.5 1.15-10.45 3.3-21.5 5.8-28 6.35-62.8 6.75-84.4.95a138 138 0 0 0-8.5-1.85c-6.85-1.25-21.35-6.55-32.1-11.7-30.3-14.5-58.75-41.6-78-74.25-6.9-11.8-15.5-29.4-19.4-39.8-3.85-10.2-4.45-12.05-6.1-17.75-1-3.3-2.1-6.95-2.55-8.1-1.55-4.15-6.95-27.65-8.95-38.9-6.75-37.65-6.9-96.95-.45-139 2-12.95 6.15-32.3 8.85-41.5.75-2.5 2.15-7.2 3.1-10.5 1.65-5.55 4-11.85 9.4-25.15 3.45-8.5 12.45-25.45 18.3-34.45 35.5-54.5 90.4-82.2 159.15-80.3 8.7.2 19.05.9 23 1.45M1755 352.65c-16.25 2-31.9 5.2-48.5 9.8-7.7 2.15-22.8 7.55-31 11.1-5.75 2.45-30 14.6-33 16.5-1.65 1.05-3.9 2.4-5 3-8.15 4.3-19.95 12.75-38.5 27.5-19.75 15.8-50.15 51.75-61.65 73-1.2 2.15-3.05 5.5-4.2 7.45-2.55 4.35-6.2 11.75-9.45 19.1-2.35 5.35-4.25 7.7-5.3 6.65-.25-.3-.55-35.1-.7-77.35l-.2-76.9-107.75-.25c-71.65-.15-107.75.1-107.75.75v826c0 1.25 224.65 1.4 225.4.15.3-.45.7-90.1.95-199.25.45-216.1.35-212.85 6.25-249.9 4.65-29.1 14.7-61.15 25.75-82 9.1-17.25 16.3-28.05 26.15-39.35 8.1-9.25 23.65-23.85 28.65-26.9a75 75 0 0 0 6.9-4.8c5.25-4.15 21.35-12.7 30.95-16.4 4.75-1.85 8.1-3.25 14.3-5.9 2.05-.9 4.5-1.65 5.4-1.65s3.9-.65 6.7-1.45c39-10.95 104.1-12.25 145.9-2.85 4.25.95 7.2 1.2 7.8.6.55-.55.8-41.85.65-105.3l-.25-104.4-2.5-1.2c-13.15-6.25-49.5-9-76-5.75m1587 0c-16.25 2-31.9 5.2-48.5 9.8-7.7 2.15-22.8 7.55-31 11.1-5.75 2.45-30 14.6-33 16.5-1.65 1.05-3.9 2.4-5 3-8.15 4.3-19.95 12.75-38.5 27.5-19.75 15.8-50.15 51.75-61.65 73-1.2 2.15-3.05 5.5-4.2 7.45-2.55 4.35-6.2 11.75-9.45 19.1-2.35 5.35-4.25 7.7-5.3 6.65-.25-.3-.55-35.1-.7-77.35l-.2-76.9-107.75-.25c-71.65-.15-107.75.1-107.75.75v826c0 1.25 224.65 1.4 225.4.15.3-.45.7-90.1.95-199.25.45-216.1.35-212.85 6.25-249.9 4.65-29.1 14.7-61.15 25.75-82 9.1-17.25 16.3-28.05 26.15-39.35 8.1-9.25 23.65-23.85 28.65-26.9a75 75 0 0 0 6.9-4.8c5.25-4.15 21.35-12.7 30.95-16.4 4.75-1.85 8.1-3.25 14.3-5.9 2.05-.9 4.5-1.65 5.4-1.65s3.9-.65 6.7-1.45c39-10.95 104.1-12.25 145.9-2.85 4.25.95 7.2 1.2 7.8.6.55-.55.8-41.85.65-105.3l-.25-104.4-2.5-1.2c-13.15-6.25-49.5-9-76-5.75" fill="currentColor" /></g>
    </svg>
  )
}

// Blurred colour field behind the dark panels and the hero.
function Plasma() {
  return (
    <div className="plasma">
      <span className="blob b1" />
      <span className="blob b2" />
      <span className="blob b3" />
      <span className="blob b4" />
      <span className="blob b5" />
    </div>
  )
}

// The same five-blob wash sits in the foot of all four feature tiles and behind
// the founder quote — identical markup in the design file, so it is one component.
function Pfill() {
  return (
    <>
      <div className="pfill">
        <i style={{ left: '-18%', top: '-40%', width: '340px', height: '300px', background: 'radial-gradient(circle,rgba(34,197,94,.62),transparent 68%)' }} />
        <i style={{ left: '34%', top: '-46%', width: '340px', height: '290px', background: 'radial-gradient(circle,rgba(16,185,129,.50),transparent 68%)' }} />
        <i style={{ left: '74%', top: '-20%', width: '320px', height: '320px', background: 'radial-gradient(circle,rgba(13,148,136,.42),transparent 68%)' }} />
        <i style={{ left: '40%', top: '52%', width: '270px', height: '250px', background: 'radial-gradient(circle,rgba(163,230,53,.40),transparent 68%)' }} />
        <i style={{ left: '-10%', top: '46%', width: '250px', height: '235px', background: 'radial-gradient(circle,rgba(52,211,153,.44),transparent 68%)' }} />
      </div>
      <div className="pgrain" />
    </>
  )
}

// Ticker amounts for the incoming-order pills, cycled in order.
const AMOUNTS = [42.18, 67.50, 128.94, 35.75, 96.20, 54.22, 173.40, 88.65, 111.18, 61.05, 149.30, 73.82]
// Order-stack depth. Mobile fits three pills in the band beside the phone,
// desktop four. Read per insert rather than captured once: a rotate or a
// resize must change the cap without remounting, and the old approach of
// hiding the overflow pill with display:none meant its exit animation ran
// on an invisible element, so the stack jumped instead of sliding.
const ORDERS_DESKTOP = 4
const ORDERS_MOBILE = 3
function orderCap() {
  if (typeof window === 'undefined' || !window.matchMedia) return ORDERS_DESKTOP
  return window.matchMedia('(max-width:760px)').matches ? ORDERS_MOBILE : ORDERS_DESKTOP
}

// Mobile comparison switcher. Mirrors the four rival columns the desktop table
// shows; the Ordr column is static beside it.
const RIVALS = [
  { name: 'DoorDash', fee: '$0', feeBad: false, com: '15–30%', comBad: true, mar: 'Negative', marBad: true },
  { name: 'ChowNow', fee: '$199', feeBad: true, com: '0%', comBad: false, mar: '78%', marBad: true },
  { name: 'Slice', fee: '$0', feeBad: false, com: '$2.50', comBad: true, mar: '58%', marBad: true },
  { name: 'Owner', fee: '$499', feeBad: true, com: '0%', comBad: false, mar: '44%', marBad: true },
]

export default function LandingPage() {
  const [contactOpen, setContactOpen] = useState(false)
  const [contactHeading, setContactHeading] = useState('')

  // Suppress PWA install prompt on landing page
  useEffect(() => {
    const suppress = (e) => e.preventDefault()
    window.addEventListener('beforeinstallprompt', suppress)
    return () => window.removeEventListener('beforeinstallprompt', suppress)
  }, [])

  function openContact(heading) {
    setContactHeading(heading)
    setContactOpen(true)
  }

  // Incoming-order pills. Newest first in the array; .orders is column-reverse,
  // so index 0 paints at the bottom and the oldest row sits on top.
  const [orders, setOrders] = useState([])
  const nextId = useRef(0)

  useEffect(() => {
    const add = () => {
      setOrders(prev => {
        const amount = AMOUNTS[nextId.current % AMOUNTS.length]
        nextId.current += 1
        const next = [{ id: nextId.current, amount }, ...prev]
        // Anything past the cap is flagged rather than dropped, so ordr-ordOut
        // has something to animate before it leaves the DOM.
        const cap = orderCap()
        return next.map((o, i) => (i >= cap ? { ...o, out: true } : o))
      })
    }

    add()
    const lead1 = setTimeout(add, 800)
    const lead2 = setTimeout(add, 1700)
    const interval = setInterval(add, 2200)

    return () => {
      clearTimeout(lead1)
      clearTimeout(lead2)
      clearInterval(interval)
    }
  }, [])

  // Retire flagged pills once the .45s exit animation has run.
  useEffect(() => {
    if (!orders.some(o => o.out)) return
    const t = setTimeout(() => setOrders(prev => prev.filter(o => !o.out)), 440)
    return () => clearTimeout(t)
  }, [orders])

  const [rival, setRival] = useState(0)
  const r = RIVALS[rival]
  const prevRival = () => setRival(i => (i - 1 + RIVALS.length) % RIVALS.length)
  const nextRival = () => setRival(i => (i + 1) % RIVALS.length)

  return (
    <>
    <div className="ordr-landing">
      <style>{CSS}</style>

      <div className="topbar">
        <span className="tag">New</span>
        <span>Loyalty is live — turn first-time orders into regulars</span>
      </div>

      <nav>
        <div className="wrap nav-in">
          <a href="#" className="lg"><OrdrLogo /></a>
          <div className="nav-links">
            <a href="#platform">Platform</a>
            <a href="#pricing">Pricing</a>
            <a href="#restaurants">Restaurants</a>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => openContact('Get a free demo')}>Get a free demo</button>
          </div>
        </div>
      </nav>

      <div className="hero">
        <Plasma />
        <div className="grain" />
        <div className="wrap hero-in">
          <div>
            <div className="pill">
              <span className="st">★★★★★</span>
              <span>Loved by independent restaurants</span>
            </div>
            <h1 className="display">The easiest way to <span className="gr">grow your restaurant</span> online.</h1>
            <p className="lede">Your own site, your own customers, your own margin — and the technology to grow direct orders 20–50%+.</p>
            <div className="cta">
              <button type="button" className="btn btn-primary" onClick={() => openContact('Request a Demo')}>Get a free demo</button>
              <a href="#platform" className="btn btn-soft">See how it works</a>
            </div>
            <p className="micro">Live in under a week · No contract · Keep your domain and your customer list</p>
            <div className="stats">
              <div className="stat"><b>0%</b><span>Commission on every order</span></div>
              <div className="stat"><b>$0</b><span>Monthly platform fee</span></div>
            </div>
          </div>

          <div className="stage">
            <div className="orders">
              {orders.map(o => (
                <div key={o.id} className={o.out ? 'ord out' : 'ord'}>
                  <span className="dot">
                    <svg viewBox="0 0 24 24"><path d="M12 19V5" /><path d="m5 12 7-7 7 7" /></svg>
                  </span>
                  <b>+${o.amount.toFixed(2)}</b>
                </div>
              ))}
            </div>

            <div className="tilt">
              <div className="iphone">
            <i className="slab" style={{ '--n': 1 }} />
            <i className="slab" style={{ '--n': 2 }} />
            <i className="slab" style={{ '--n': 3 }} />
            <i className="slab" style={{ '--n': 4 }} />
            <i className="slab" style={{ '--n': 5 }} />
            <i className="slab" style={{ '--n': 6 }} />
            <i className="slab" style={{ '--n': 7 }} />
            <i className="slab" style={{ '--n': 8 }} />
            <i className="slab" style={{ '--n': 9 }} />
            <i className="slab" style={{ '--n': 10 }} />
            <i className="slab" style={{ '--n': 11 }} />
            <i className="slab" style={{ '--n': 12 }} />
            <i className="slab" style={{ '--n': 13 }} />
            <i className="slab" style={{ '--n': 14 }} />
            <i className="slab" style={{ '--n': 15 }} />
            <i className="slab" style={{ '--n': 16 }} />
            <i className="slab" style={{ '--n': 17 }} />
            <i className="slab" style={{ '--n': 18 }} />
            <i className="slab" style={{ '--n': 19 }} />
            <i className="slab" style={{ '--n': 20 }} />
                <div className="face">
                  <div className="bezel">
                    <div className="screen">
                      <div className="island" />
                      <div className="status"><span>1:39</span><span>●●● ▮▮</span></div>
                      <div className="shot" style={{ backgroundImage: `url(${stellaHero})` }}>
                        <div className="sname"><b>Stella</b><u>● Open till 9:45 PM</u></div>
                      </div>
                      <div className="sbody">
                        <div className="seg"><div className="on">Pickup</div><div>Delivery</div></div>
                        <div className="rwh"><b>Earn rewards</b><span>Explore ›</span></div>
                        <div className="rw">
                          <div className="dots">
                            <i className="rw5">$5</i>
                            <i style={{ backgroundImage: `url(${rewardChoppedSalad})` }} />
                            <i style={{ backgroundImage: `url(${rewardCheesePizza})` }} />
                          </div>
                          <div className="bar">
                            <div className="t"><i /></div>
                            <div className="n2"><span>100</span><span>500</span></div>
                          </div>
                        </div>
                        <div className="menu">
                          <div className="mi">
                            <span className="th" style={{ backgroundImage: `url(${menuParmigiana})` }} />
                            <span className="nm2"><b>Parmigiana</b><span>Marinara, fresh mozzarella, linguine</span></span>
                            <span className="pr">$24.00</span>
                          </div>
                          <div className="mi">
                            <span className="th" style={{ backgroundImage: `url(${menuJamminBrussels})` }} />
                            <span className="nm2"><b>Jammin’ Brussels</b><span>Crispy pancetta, fig jam</span></span>
                            <span className="pr">$15.00</span>
                          </div>
                          <div className="mi">
                            <span className="th" style={{ backgroundImage: `url(${menuFriedMozzarella})` }} />
                            <span className="nm2"><b>Fried Mozzarella</b><span>Marinara, parmigiano reggiano</span></span>
                            <span className="pr">$14.00</span>
                          </div>
                        </div>
                        <div className="cofoot">
                          <div className="ptsline">+530 points</div>
                          <div className="cobar">
                            <div className="l"><b>CHECKOUT</b><span>$53.00</span></div>
                            <div className="cnt">3</div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="marq">
        <div className="marq-l">Trusted by independent restaurants</div>
        <div className="track">
          <span>Stella</span><span>Frank’s Pizza</span><span>Bella Pizza</span><span>Pazza</span><span>New Park Tavern</span><span>Gino’s</span><span>Morano’s</span><span>Park Pizza</span><span>Torino</span><span>Gaby’s</span>
          <span>Stella</span><span>Frank’s Pizza</span><span>Bella Pizza</span><span>Pazza</span><span>New Park Tavern</span><span>Gino’s</span><span>Morano’s</span><span>Park Pizza</span><span>Torino</span><span>Gaby’s</span>
        </div>
      </div>

      <section id="platform">
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">What’s included</span>
            <h2 className="h2">The technology to grow direct online orders <span className="gr">20–50%+</span>.</h2>
            <p>Marketplaces grow their business with your food. Ordr grows yours — more direct orders, more repeat customers, and every dollar of margin still yours.</p>
          </div>
          <div className="tiles">

            <div className="t2">
              <div className="top">
                <h3 className="h3">High-conversion checkout</h3>
                <div className="vis">
                  <span className="mkbare"><img src={applePay} alt="Apple Pay" /></span>
                  <span className="mkbare"><img src={gpayMark} alt="Google Pay" /></span>
                </div>
              </div>
              <div className="bot">
                <Pfill />
                <p>One-tap pay and the fewest steps to order in the business. Fewer taps, fewer abandoned carts.</p>
              </div>
            </div>

            <div className="t2">
              <div className="top">
                <h3 className="h3">Delivery, no marketplace</h3>
                <div className="vis">
                  <span className="mkbox"><img src={uberDirect} alt="Uber Direct" /></span>
                </div>
              </div>
              <div className="bot">
                <Pfill />
                <p>No drivers, or need a wider radius? Uber Direct covers it — at cost, zero marketplace commission.</p>
              </div>
            </div>

            <div className="t2">
              <div className="top">
                <h3 className="h3">Rank on Google</h3>
                <div className="vis">
                  <div className="srank">
                    <div className="sr on">
                      <span className="fav" />
                      <div className="ln"><b>Your Restaurant</b><i /></div>
                    </div>
                    <div className="sr off">
                      <span className="fav" />
                      <div className="ln"><i /><i /></div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bot">
                <Pfill />
                <p>An SEO-built site on your own domain, indexed page by page, competing for the top slots. Included.</p>
              </div>
            </div>

            <div className="t2">
              <div className="top">
                <h3 className="h3">Loyalty that brings them back</h3>
                <div className="vis">
                  <div className="lylt">
                    <div className="ptsline">+530 points</div>
                    <div className="cobar">
                      <div className="l"><b>CHECKOUT</b><span>$53.00</span></div>
                      <div className="cnt">3</div>
                    </div>
                  </div>
                </div>
              </div>
              <div className="bot">
                <Pfill />
                <p>Points on every order, rewards they can see at checkout — the most interactive ordering in the space.</p>
              </div>
            </div>

          </div>
        </div>
      </section>

      <section id="pricing" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="sec-head">
            <span className="eyebrow">The math</span>
            <h2 className="h2">The <span className="gr">most profitable</span> online ordering system in restaurant tech.</h2>
            <p>Marketplaces take 15–30% before you’ve paid for flour. Others charge you every month to take your own orders. Ordr keeps your profits in your pocket.</p>
          </div>

          <div className="tblwrap">
            <div className="tblcap">
              <b>What it actually costs you</b>
              <span>150 orders/mo · $30 average ticket · 20% net margin</span>
            </div>
            <div className="tblbody">
              <div className="ocol" />
              <table>
                <colgroup>
                  <col style={{ width: '26%' }} /><col /><col /><col /><col /><col style={{ width: '15.5%' }} />
                </colgroup>
                <thead>
                  <tr>
                    <th />
                    <th>DoorDash</th>
                    <th>ChowNow</th>
                    <th>Slice</th>
                    <th>Owner</th>
                    <th className="oc"><span className="oclogo"><OrdrLogo /></span></th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>Monthly fee</td>
                    <td>$0</td>
                    <td className="bad">$199</td>
                    <td>$0</td>
                    <td className="bad">$499</td>
                    <td className="oc"><span>$0</span></td>
                  </tr>
                  <tr>
                    <td>Commission</td>
                    <td className="bad">15–30%</td>
                    <td>0%</td>
                    <td className="bad">$2.50</td>
                    <td>0%</td>
                    <td className="oc"><span>0%</span></td>
                  </tr>
                  <tr>
                    <td>Margin you keep</td>
                    <td className="bad ul"><span className="uw">Negative<svg className="scrib " viewBox="0 0 120 18" preserveAspectRatio="none">
                <path d="M2,13.2 C22,10.4 46,12.3 70,9.5 94,6.9 108,7.7 118,5.3" stroke="#C0392B" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity=".95" />
                <path d="M3.4,14.6 C24,11.9 47,13.6 71,10.8 95,8.3 109,9.1 117,6.8" stroke="#C0392B" strokeWidth="1.15" fill="none" strokeLinecap="round" opacity=".38" />
              </svg></span></td>
                    <td className="bad ul"><span className="uw">78%<svg className="scrib " viewBox="0 0 120 18" preserveAspectRatio="none">
                <path d="M3,12.7 C26,11.1 44,9.7 68,10.9 92,11.9 106,7.3 117,5.9" stroke="#C0392B" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity=".95" />
                <path d="M4,14.2 C27,12.6 45,11.2 69,12.3 93,13.3 107,8.8 116,7.4" stroke="#C0392B" strokeWidth="1.15" fill="none" strokeLinecap="round" opacity=".38" />
              </svg></span></td>
                    <td className="bad ul"><span className="uw">58%<svg className="scrib " viewBox="0 0 120 18" preserveAspectRatio="none">
                <path d="M2,13.9 C20,9.9 50,12.7 74,9.1 96,6.1 110,8.1 118,4.9" stroke="#C0392B" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity=".95" />
                <path d="M3.2,15.3 C21,11.4 51,14.1 75,10.6 97,7.6 111,9.5 117,6.4" stroke="#C0392B" strokeWidth="1.15" fill="none" strokeLinecap="round" opacity=".38" />
              </svg></span></td>
                    <td className="bad ul"><span className="uw">44%<svg className="scrib " viewBox="0 0 120 18" preserveAspectRatio="none">
                <path d="M3,13.1 C24,12.1 48,9.3 72,10.7 94,11.8 108,6.7 117,5.1" stroke="#C0392B" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity=".95" />
                <path d="M4.2,14.6 C25,13.5 49,10.8 73,12.1 95,13.2 109,8.2 116,6.6" stroke="#C0392B" strokeWidth="1.15" fill="none" strokeLinecap="round" opacity=".38" />
              </svg></span></td>
                    <td className="oc ul"><span>100%</span><svg className="scrib long" viewBox="0 0 120 18" preserveAspectRatio="none">
                <path d="M2,14.1 C22,10.7 52,12.9 76,9.3 98,6.3 112,7.5 118,4.7" stroke="#4ADE80" strokeWidth="2.5" fill="none" strokeLinecap="round" opacity=".95" />
                <path d="M3.3,15.5 C23,12.2 53,14.3 77,10.8 99,7.8 113,9 117,6.2" stroke="#4ADE80" strokeWidth="1.15" fill="none" strokeLinecap="round" opacity=".38" />
              </svg></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>

          <div className="cmp">
            <div className="cmp-cap">
              <b>What it actually costs you</b>
              <span>150 orders/mo · $30 average ticket · 20% net margin</span>
            </div>
            <div className="cmp-grid">
              <div className="hd lbl" />
              <div className="hd oc2"><span className="oclogo2"><OrdrLogo /></span></div>
              <div className="hd">
                <span className="nav-cmp">
                  <button type="button" onClick={prevRival} aria-label="Previous">
                    <svg viewBox="0 0 24 24"><path d="m15 18-6-6 6-6" /></svg>
                  </button>
                  <span className="who2">{r.name}</span>
                  <button type="button" onClick={nextRival} aria-label="Next">
                    <svg viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
                  </button>
                </span>
              </div>

              <div className="lbl">Monthly fee</div>
              <div className="oc2">$0</div>
              <div className={r.feeBad ? 'bad' : undefined}>{r.fee}</div>

              <div className="lbl">Commission</div>
              <div className="oc2">0%</div>
              <div className={r.comBad ? 'bad' : undefined}>{r.com}</div>

              <div className="lbl">Margin you keep</div>
              <div className="oc2">100%</div>
              <div className={r.marBad ? 'bad' : undefined}>{r.mar}</div>
            </div>
            <div className="cmp-dots">
              {RIVALS.map((_, n) => <i key={n} className={n === rival ? 'on' : undefined} />)}
            </div>
          </div>

          <div className="soonstrip">
            <span className="bd">Coming soon</span>
            <p>Order consolidation — third-party tickets on the same tablet and printer as your direct orders.</p>
            <div className="lbls">
              <span className="lb">DoorDash</span>
              <span className="lb">Uber Eats</span>
              <span className="lb">Grubhub</span>
            </div>
          </div>
        </div>
      </section>

      <section id="restaurants" style={{ paddingTop: 0 }}>
        <div className="wrap">
          <div className="refs">
            <div className="plasma">
              <span className="blob" style={{ width: '640px', height: '500px', left: '-8%', top: '-40%', background: 'radial-gradient(circle,rgba(34,197,94,1),rgba(34,197,94,0) 62%)' }} />
              <span className="blob" style={{ width: '580px', height: '460px', left: '24%', top: '-34%', background: 'radial-gradient(circle,rgba(16,185,129,.92),rgba(16,185,129,0) 62%)' }} />
              <span className="blob" style={{ width: '620px', height: '520px', right: '-6%', top: '-32%', background: 'radial-gradient(circle,rgba(45,212,191,.85),rgba(45,212,191,0) 62%)' }} />
              <span className="blob" style={{ width: '540px', height: '440px', left: '10%', bottom: '-40%', background: 'radial-gradient(circle,rgba(163,230,53,.6),rgba(163,230,53,0) 64%)' }} />
              <span className="blob" style={{ width: '560px', height: '460px', right: '6%', bottom: '-44%', background: 'radial-gradient(circle,rgba(34,197,94,.78),rgba(34,197,94,0) 64%)' }} />
            </div>
            <div className="grain" />
            <span className="eyebrow">Ask for references</span>
            <h2>Every one of our restaurant partners will <span className="gr">speak on our behalf</span>.</h2>
            <p>Our platform is proven — and we want you to hear it from owners who are living it.</p>
          </div>

          <div className="founder">
            <Pfill />
            <div className="q">“<b>You shouldn’t have to pay to take your own orders.</b> I’m here to increase your bottom line.”</div>
            <div className="byline">
              <div className="nm">Matthew Simone · Founder &amp; developer, Ordr</div>
              <img className="autograph" src={ordrSignature} alt="Matthew Simone" />
            </div>
          </div>
        </div>
      </section>

      <div className="wrap" id="demo">
        <div className="final">
          <div className="plasma">
            <span className="blob" style={{ width: '620px', height: '480px', left: '-10%', top: '-38%', background: 'radial-gradient(circle,rgba(34,197,94,1),rgba(34,197,94,0) 62%)' }} />
            <span className="blob" style={{ width: '560px', height: '440px', left: '18%', top: '-30%', background: 'radial-gradient(circle,rgba(16,185,129,.92),rgba(16,185,129,0) 62%)' }} />
            <span className="blob" style={{ width: '600px', height: '500px', right: '-8%', top: '-30%', background: 'radial-gradient(circle,rgba(45,212,191,.85),rgba(45,212,191,0) 62%)' }} />
            <span className="blob" style={{ width: '520px', height: '420px', left: '8%', bottom: '-38%', background: 'radial-gradient(circle,rgba(163,230,53,.62),rgba(163,230,53,0) 64%)' }} />
            <span className="blob" style={{ width: '560px', height: '460px', right: '4%', bottom: '-42%', background: 'radial-gradient(circle,rgba(34,197,94,.75),rgba(34,197,94,0) 64%)' }} />
          </div>
          <div className="grain" />
          <h2 className="display">Stop paying for <span className="gr">your own customers</span>.</h2>
          <p>Fifteen minutes, and we’ll show you what last month would have looked like on Ordr.</p>
          <div className="cta">
            <button type="button" className="btn btn-white" onClick={() => openContact('Get Started')}>Get a free demo</button>
          </div>
        </div>
      </div>

      <footer>
        <div className="wrap foot">
          <a href="#" className="lg" style={{ height: '28px' }}><OrdrLogo /></a>
          <div className="foot-links">
            <a href="#platform">Platform</a>
            <a href="#pricing">Pricing</a>
            <a href="#restaurants">Restaurants</a>
            <a href="#">Privacy</a>
            <a href="#">Terms</a>
          </div>
          <div className="copy">© 2026 Ordr</div>
        </div>
      </footer>
    </div>

    <ContactFormDialog open={contactOpen} onOpenChange={setContactOpen} heading={contactHeading} />
    </>
  )
}
