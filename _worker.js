const GOOGLE_FORM='https://docs.google.com/forms/d/e/1FAIpQLScbpRswoCbWtfdM_0oyOq0Q2wthCVuxztYfiT02W4uXHLTKlg/formResponse';
const ENTRIES={nombre:'entry.314691855',correo:'entry.1828749494',whatsapp:'entry.1013330642',destinatario:'entry.1780938346',relacion:'entry.1559767204',ocasion:'entry.657874015',historia:'entry.2015353262',recuerdos:'entry.739824271',frase:'entry.1693350233',evitar:'entry.1255368010',estilo:'entry.2048079322',voz:'entry.1222206002',emocion:'entry.236304043',ritmo:'entry.510145914',condiciones:'entry.1729874179'};
const CONDITIONS='He leído y acepto que el precio de lanzamiento es de US$15, que el tiempo estimado de entrega es de 1 a 3 días hábiles y que el servicio incluye una única versión final de la canción, sin modificaciones posteriores. Confirmo que he incluido en este formulario toda la información que deseo que se tenga en cuenta para crearla.';
const json=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json;charset=UTF-8','cache-control':'no-store'}});

async function createOrder(request,env){
  let data; try{data=await request.json()}catch{return json({error:'Solicitud inválida'},400)}
  if(!data||!data.comprador_email||!data.comprador_nombre||!data.historia)return json({error:'Faltan datos obligatorios'},400);
  const id='ME-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomUUID().slice(0,6).toUpperCase();
  await env.ORDERS_DB.prepare('INSERT INTO orders (id,provider,status,form_data) VALUES (?,?,?,?)').bind(id,'mercadopago','pending',JSON.stringify(data)).run();
  const origin=new URL(request.url).origin;
  const preference={items:[{id:'cancion-personalizada',title:'Canción personalizada – Melodía Eterna',description:'Canción personalizada creada a partir de tu historia',quantity:1,currency_id:'CLP',unit_price:15000}],payer:{email:data.comprador_email,name:data.comprador_nombre},external_reference:id,metadata:{order_id:id},back_urls:{success:origin+'/pago-exitoso?order='+encodeURIComponent(id),pending:origin+'/pago-exitoso?order='+encodeURIComponent(id)+'&result=pending',failure:origin+'/pago-exitoso?order='+encodeURIComponent(id)+'&result=failure'},auto_return:'approved',notification_url:origin+'/api/mercadopago/webhook'};
  const response=await fetch('https://api.mercadopago.com/checkout/preferences',{method:'POST',headers:{authorization:'Bearer '+env.MP_ACCESS_TOKEN,'content-type':'application/json'},body:JSON.stringify(preference)});
  const result=await response.json();
  if(!response.ok){await env.ORDERS_DB.prepare("UPDATE orders SET status='error' WHERE id=?").bind(id).run();return json({error:'No pudimos iniciar el pago'},502)}
  await env.ORDERS_DB.prepare('UPDATE orders SET checkout_id=? WHERE id=?').bind(result.id,id).run();
  return json({orderId:id,checkoutUrl:result.sandbox_init_point||result.init_point});
}


async function paypalToken(env){
  const r=await fetch('https://api-m.paypal.com/v1/oauth2/token',{method:'POST',headers:{authorization:'Basic '+btoa(env.PAYPAL_CLIENT_ID+':'+env.PAYPAL_CLIENT_SECRET),'content-type':'application/x-www-form-urlencoded'},body:'grant_type=client_credentials'});
  const d=await r.json();if(!r.ok||!d.access_token)throw new Error('PayPal auth');return d.access_token;
}
async function createPayPalOrder(request,env){
  let data;try{data=await request.json()}catch{return json({error:'Solicitud inválida'},400)}
  if(!data||!data.comprador_email||!data.comprador_nombre||!data.historia)return json({error:'Faltan datos obligatorios'},400);
  const id='ME-'+Date.now().toString(36).toUpperCase()+'-'+crypto.randomUUID().slice(0,6).toUpperCase();
  await env.ORDERS_DB.prepare('INSERT INTO orders (id,provider,status,form_data) VALUES (?,?,?,?)').bind(id,'paypal','pending',JSON.stringify(data)).run();
  const origin=new URL(request.url).origin,token=await paypalToken(env);
  const order={intent:'CAPTURE',purchase_units:[{custom_id:id,description:'Canción personalizada – Melodía Eterna',amount:{currency_code:'USD',value:'15.00'}}],payment_source:{paypal:{experience_context:{brand_name:'Melodía Eterna',user_action:'PAY_NOW',return_url:origin+'/api/paypal/capture?order='+encodeURIComponent(id),cancel_url:origin+'/pago-exitoso?order='+encodeURIComponent(id)+'&result=failure'}}}};
  const r=await fetch('https://api-m.paypal.com/v2/checkout/orders',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','paypal-request-id':id},body:JSON.stringify(order)});const d=await r.json();
  if(!r.ok){await env.ORDERS_DB.prepare("UPDATE orders SET status='error' WHERE id=?").bind(id).run();return json({error:'No pudimos iniciar el pago con PayPal'},502)}
  await env.ORDERS_DB.prepare('UPDATE orders SET checkout_id=? WHERE id=?').bind(d.id,id).run();
  const approve=(d.links||[]).find(x=>x.rel==='payer-action'||x.rel==='approve');return approve?json({orderId:id,checkoutUrl:approve.href}):json({error:'PayPal no devolvió el enlace de pago'},502);
}
async function capturePayPal(request,env,ctx){
  const u=new URL(request.url),id=u.searchParams.get('order'),paypalId=u.searchParams.get('token');if(!id||!paypalId)return Response.redirect(u.origin+'/pago-exitoso?result=failure',302);
  const row=await env.ORDERS_DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();if(!row||row.provider!=='paypal')return Response.redirect(u.origin+'/pago-exitoso?order='+encodeURIComponent(id)+'&result=failure',302);
  const token=await paypalToken(env),r=await fetch('https://api-m.paypal.com/v2/checkout/orders/'+encodeURIComponent(paypalId)+'/capture',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json','paypal-request-id':id+'-capture'}}),d=await r.json();
  const cap=d.purchase_units&&d.purchase_units[0]&&d.purchase_units[0].payments&&d.purchase_units[0].payments.captures&&d.purchase_units[0].payments.captures[0];
  if(r.ok&&d.status==='COMPLETED'&&cap&&cap.status==='COMPLETED'&&cap.amount.currency_code==='USD'&&cap.amount.value==='15.00'){await env.ORDERS_DB.prepare("UPDATE orders SET status='paid',payment_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=?").bind(String(cap.id),id).run();ctx.waitUntil(sendToSheet(env,{...row,id,status:'paid'}));return Response.redirect(u.origin+'/pago-exitoso?order='+encodeURIComponent(id),302)}
  await env.ORDERS_DB.prepare("UPDATE orders SET status='pending' WHERE id=?").bind(id).run();return Response.redirect(u.origin+'/pago-exitoso?order='+encodeURIComponent(id)+'&result=pending',302);
}

async function sendToSheet(env,order){
  if(order.sheet_sent)return;
  const d=JSON.parse(order.form_data); const p=new URLSearchParams();
  p.set(ENTRIES.nombre,d.comprador_nombre||'');p.set(ENTRIES.correo,d.comprador_email||'');p.set(ENTRIES.whatsapp,d.comprador_whatsapp||'');p.set(ENTRIES.destinatario,d.destinatario_nombre||'');p.set(ENTRIES.relacion,d.relacion||'');p.set(ENTRIES.ocasion,d.ocasion||'');p.set(ENTRIES.historia,d.historia||'');p.set(ENTRIES.recuerdos,d.recuerdos||'');p.set(ENTRIES.frase,d.frase_especial||'');p.set(ENTRIES.evitar,d.evitar||'');p.set(ENTRIES.estilo,d.estilo||'');p.set(ENTRIES.voz,d.voz||'');p.set(ENTRIES.emocion,d.emocion||'');p.set(ENTRIES.ritmo,d.ritmo||'');p.set(ENTRIES.condiciones,CONDITIONS);
  const r=await fetch(GOOGLE_FORM,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:p.toString()});
  if(r.ok)await env.ORDERS_DB.prepare('UPDATE orders SET sheet_sent=1 WHERE id=?').bind(order.id).run();
}

async function webhook(request,env,ctx){
  const url=new URL(request.url);let body={};try{if(request.method==='POST')body=await request.json()}catch{}
  const paymentId=url.searchParams.get('data.id')||url.searchParams.get('id')||(body.data&&body.data.id);
  if(!paymentId)return json({ok:true});
  const r=await fetch('https://api.mercadopago.com/v1/payments/'+encodeURIComponent(paymentId),{headers:{authorization:'Bearer '+env.MP_ACCESS_TOKEN}});
  if(!r.ok)return json({ok:false},200);
  const payment=await r.json(); const id=payment.external_reference;
  if(!id||payment.currency_id!=='CLP'||Number(payment.transaction_amount)!==15000)return json({ok:true});
  const order=await env.ORDERS_DB.prepare('SELECT * FROM orders WHERE id=?').bind(id).first();
  if(!order)return json({ok:true});
  if(payment.status==='approved'){
    await env.ORDERS_DB.prepare("UPDATE orders SET status='paid',payment_id=?,paid_at=CURRENT_TIMESTAMP WHERE id=?").bind(String(paymentId),id).run();
    ctx.waitUntil(sendToSheet(env,{...order,id,status:'paid'}));
  }else await env.ORDERS_DB.prepare('UPDATE orders SET status=?,payment_id=? WHERE id=?').bind(payment.status||'pending',String(paymentId),id).run();
  return json({ok:true});
}

async function orderStatus(id,env){const row=await env.ORDERS_DB.prepare('SELECT id,status,created_at,paid_at FROM orders WHERE id=?').bind(id).first();return row?json(row):json({error:'Pedido no encontrado'},404)}
function successPage(){return new Response('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Estado del pago | Melodía Eterna</title><style>body{margin:0;background:#fff8f5;color:#6f1838;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh}.card{max-width:560px;margin:24px;padding:42px;background:white;border:1px solid #ead7d0;border-radius:28px;text-align:center;box-shadow:0 18px 50px #6f18381a}h1{font-size:34px}p{color:#725a63;line-height:1.6}.ok{font-size:54px}.id{font-weight:bold}</style><main class="card"><div class="ok">♡</div><h1 id="title">Confirmando tu pago…</h1><p id="message">Estamos verificando la operación de forma segura. Esto puede tardar unos segundos.</p><p class="id" id="order"></p></main><script>const q=new URLSearchParams(location.search),id=q.get("order"),t=document.getElementById("title"),m=document.getElementById("message");document.getElementById("order").textContent=id?"Pedido "+id:"";let tries=0;async function check(){if(!id)return;try{const r=await fetch("/api/orders/"+encodeURIComponent(id),{cache:"no-store"}),d=await r.json();if(d.status==="paid"){t.textContent="¡Pago confirmado!";m.textContent="Recibimos tu solicitud y tu canción ya está en camino. Te contactaremos por los datos que nos dejaste.";return}if(q.get("result")==="failure"){t.textContent="El pago no se completó";m.textContent="Tu solicitud está guardada. Puedes volver e intentar el pago nuevamente.";return}}catch{}if(++tries<15)setTimeout(check,2000);else{t.textContent="Pago en verificación";m.textContent="Tu solicitud está guardada. Te confirmaremos en cuanto el proveedor de pago complete la verificación."}}check();</script></html>',{headers:{'content-type':'text/html;charset=UTF-8','cache-control':'no-store'}})}

export default{async fetch(request,env,ctx){const url=new URL(request.url);try{if(url.pathname==='/api/create-mercadopago-order'&&request.method==='POST')return createOrder(request,env);if(url.pathname==='/api/create-paypal-order'&&request.method==='POST')return createPayPalOrder(request,env);if(url.pathname==='/api/paypal/capture'&&request.method==='GET')return capturePayPal(request,env,ctx);if(url.pathname==='/api/mercadopago/webhook')return webhook(request,env,ctx);if(url.pathname.startsWith('/api/orders/')&&request.method==='GET')return orderStatus(decodeURIComponent(url.pathname.slice(12)),env);if(url.pathname==='/pago-exitoso')return successPage();return env.ASSETS.fetch(request)}catch(e){return json({error:'Error temporal del servicio'},500)}}};
