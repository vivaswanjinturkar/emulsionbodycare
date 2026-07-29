const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { Resend } = require('resend');

module.exports = async (req, res) => {
  // Set CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      checkoutDetails,
      cart,
      totalAmount
    } = req.body;

    if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature || !checkoutDetails || !cart || !totalAmount) {
      return res.status(400).json({ error: 'Missing required checkout or payment parameters' });
    }

    const key_secret = process.env.RAZORPAY_KEY_SECRET;
    if (!key_secret) {
      return res.status(500).json({ error: 'Razorpay secret key not configured on server' });
    }

    // 1. Verify Razorpay Signature
    const hmac = crypto.createHmac('sha256', key_secret);
    hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
    const generated_signature = hmac.digest('hex');

    if (generated_signature !== razorpay_signature) {
      return res.status(400).json({ error: 'Payment signature verification failed. Transaction invalid.' });
    }

    // 2. Generate Unique Order Number (EBC- + last 6 digits of timestamp)
    const order_number = 'EBC-' + String(Date.now()).slice(-6);

    // 3. Save to Supabase Database
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    let dbSuccess = false;
    let dbErrorMsg = '';

    if (supabaseUrl && supabaseServiceKey) {
      try {
        const supabase = createClient(supabaseUrl, supabaseServiceKey);
        const { error } = await supabase
          .from('orders')
          .insert([
            {
              order_number: order_number,
              customer_name: checkoutDetails.name,
              customer_email: checkoutDetails.email,
              customer_phone: checkoutDetails.phone,
              shipping_address: checkoutDetails.address,
              city: checkoutDetails.city,
              state: checkoutDetails.state,
              pincode: checkoutDetails.pin,
              items: cart,
              total_amount: totalAmount,
              payment_id: razorpay_payment_id,
              payment_status: 'paid'
            }
          ]);

        if (error) {
          console.error('Supabase insert error:', error);
          dbErrorMsg = error.message;
        } else {
          dbSuccess = true;
        }
      } catch (dbErr) {
        console.error('Database connection failed:', dbErr);
        dbErrorMsg = dbErr.message;
      }
    } else {
      console.warn('Supabase URL or Key is missing. Skipping database save.');
      dbErrorMsg = 'Supabase credentials missing';
    }

    // 4. Send Transactional Emails (Resend)
    const resendApiKey = process.env.RESEND_API_KEY;
    const storeOwnerEmail = process.env.STORE_OWNER_EMAIL || 'hello@emulsionbodycare.com';
    let emailSuccess = false;
    let emailErrorMsg = '';

    if (resendApiKey) {
      try {
        const resend = new Resend(resendApiKey);

        // Build itemized HTML table rows
        const itemsHtmlRows = cart.map(item => `
          <tr>
            <td style="padding: 12px; border-bottom: 1px solid #EFE9DC; font-family: sans-serif; font-size: 14px; color: #2A3026;">${item.name}</td>
            <td style="padding: 12px; border-bottom: 1px solid #EFE9DC; font-family: sans-serif; font-size: 14px; color: #2A3026; text-align: center;">${item.quantity}</td>
            <td style="padding: 12px; border-bottom: 1px solid #EFE9DC; font-family: sans-serif; font-size: 14px; color: #2A3026; text-align: right;">₹${item.price * item.quantity}</td>
          </tr>
        `).join('');

        // Clean brand-styled email layout for the customer
        const customerEmailHtml = `
          <div style="background-color: #FAF7F2; padding: 40px 20px; font-family: 'Helvetica Neue', Helvetica, Arial, sans-serif;">
            <table cellpadding="0" cellspacing="0" style="max-width: 600px; margin: 0 auto; background-color: #FFFFFF; border: 1px solid rgba(42, 48, 38, 0.07); width: 100%;">
              <!-- Header -->
              <tr>
                <td style="background-color: #8B9B82; padding: 30px; text-align: center;">
                  <h1 style="color: #EFE9DC; font-family: Georgia, serif; font-size: 26px; font-weight: normal; margin: 0; letter-spacing: 0.05em; text-transform: lowercase;">emulsion</h1>
                  <p style="color: rgba(239, 233, 220, 0.85); font-family: sans-serif; font-size: 12px; text-transform: uppercase; letter-spacing: 0.1em; margin: 5px 0 0 0;">Doctor-Formulated Skincare</p>
                </td>
              </tr>
              <!-- Content Body -->
              <tr>
                <td style="padding: 40px 30px;">
                  <h2 style="font-family: Georgia, serif; font-size: 20px; font-weight: normal; color: #2A3026; margin: 0 0 16px 0;">Order Confirmed</h2>
                  <p style="font-size: 15px; line-height: 1.6; color: #4C5448; margin: 0 0 24px 0;">Hi ${checkoutDetails.name},</p>
                  <p style="font-size: 15px; line-height: 1.6; color: #4C5448; margin: 0 0 24px 0;">Thank you for adopting our daily skincare ritual. Your order has been successfully received and is being carefully prepared in Pune, India.</p>
                  
                  <!-- Order Number Panel -->
                  <div style="background-color: #FAF7F2; border-left: 3px solid #8B9B82; padding: 16px; margin-bottom: 30px;">
                    <p style="margin: 0; font-size: 14px; color: #4C5448;">Order Reference: <strong>${order_number}</strong></p>
                    <p style="margin: 4px 0 0 0; font-size: 14px; color: #4C5448;">Payment Reference: <strong>${razorpay_payment_id}</strong></p>
                  </div>

                  <!-- Product Table -->
                  <h3 style="font-family: sans-serif; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #8B9B82; margin: 0 0 12px 0; border-bottom: 1px solid #EFE9DC; padding-bottom: 6px;">Your Selection</h3>
                  <table cellpadding="0" cellspacing="0" style="width: 100%; margin-bottom: 30px;">
                    <thead>
                      <tr style="background-color: #FAF7F2;">
                        <th style="padding: 8px 12px; font-family: sans-serif; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #4C5448; text-align: left;">Item</th>
                        <th style="padding: 8px 12px; font-family: sans-serif; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #4C5448; text-align: center;">Qty</th>
                        <th style="padding: 8px 12px; font-family: sans-serif; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #4C5448; text-align: right;">Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      ${itemsHtmlRows}
                      <tr>
                        <td colspan="2" style="padding: 16px 12px; font-family: sans-serif; font-size: 14px; font-weight: bold; color: #2A3026; text-align: right;">Subtotal</td>
                        <td style="padding: 16px 12px; font-family: sans-serif; font-size: 16px; font-weight: bold; color: #2A3026; text-align: right;">₹${totalAmount}</td>
                      </tr>
                    </tbody>
                  </table>

                  <!-- Shipping details -->
                  <h3 style="font-family: sans-serif; font-size: 12px; text-transform: uppercase; letter-spacing: 0.08em; color: #8B9B82; margin: 0 0 12px 0; border-bottom: 1px solid #EFE9DC; padding-bottom: 6px;">Delivery Details</h3>
                  <p style="font-size: 14px; line-height: 1.6; color: #4C5448; margin: 0 0 8px 0;">
                    <strong>Recipient:</strong> ${checkoutDetails.name}<br>
                    <strong>Shipping Address:</strong> ${checkoutDetails.address}, ${checkoutDetails.city}, ${checkoutDetails.state} - ${checkoutDetails.pin}<br>
                    <strong>Contact Phone:</strong> ${checkoutDetails.phone}
                  </p>
                  <p style="font-size: 13px; color: #73806C; margin: 16px 0 0 0; font-style: italic;">Your packages will ship via express courier in 1-2 business days. Delivery typically takes 3-5 business days.</p>
                </td>
              </tr>
              <!-- Footer -->
              <tr>
                <td style="background-color: #2A3026; padding: 30px; text-align: center; font-family: sans-serif; font-size: 12px; color: rgba(239, 233, 220, 0.7);">
                  <p style="margin: 0 0 8px 0;">&copy; 2026 Emulsion Body Care. All rights reserved.</p>
                  <p style="margin: 0;">For inquiries or changes to your delivery, email <a href="mailto:hello@emulsionbodycare.com" style="color: #EFE9DC; text-decoration: underline;">hello@emulsionbodycare.com</a></p>
                </td>
              </tr>
            </table>
          </div>
        `;

        // Store Owner Alert
        const ownerEmailHtml = `
          <div style="font-family: sans-serif; padding: 20px; color: #333;">
            <h2>New Order Alert - ${order_number}</h2>
            <p>A new purchase has been confirmed via Razorpay checkout.</p>
            <hr>
            <h3>Customer Info</h3>
            <p>
              <strong>Name:</strong> ${checkoutDetails.name}<br>
              <strong>Email:</strong> ${checkoutDetails.email}<br>
              <strong>Phone:</strong> ${checkoutDetails.phone}
            </p>
            <h3>Shipping Details</h3>
            <p>${checkoutDetails.address}, ${checkoutDetails.city}, ${checkoutDetails.state} - ${checkoutDetails.pin}</p>
            <hr>
            <h3>Purchased Items</h3>
            <ul>
              ${cart.map(item => `<li>${item.name} (x${item.quantity}) - ₹${item.price * item.quantity}</li>`).join('')}
            </ul>
            <p><strong>Total Amount Paid:</strong> ₹${totalAmount}</p>
            <p><strong>Razorpay Payment ID:</strong> ${razorpay_payment_id}</p>
          </div>
        `;

        // If domain is unverified, fallback to onboarding sender
        const isVerifiedDomain = resendApiKey.startsWith('re_live_') || storeOwnerEmail.endsWith('@emulsionbodycare.com');
        const fromEmail = isVerifiedDomain 
          ? 'Emulsion Body Care <orders@emulsionbodycare.com>'
          : 'Emulsion Body Care <onboarding@resend.dev>';

        // Send customer receipt
        await resend.emails.send({
          from: fromEmail,
          to: checkoutDetails.email,
          subject: `Your Emulsion Order Confirmation - ${order_number}`,
          html: customerEmailHtml
        });

        // Send owner alert
        await resend.emails.send({
          from: fromEmail,
          to: storeOwnerEmail,
          subject: `Alert: New Order ${order_number} received (₹${totalAmount})`,
          html: ownerEmailHtml
        });

        emailSuccess = true;
      } catch (emailErr) {
        console.error('Resend email dispatch error:', emailErr);
        emailErrorMsg = emailErr.message;
      }
    } else {
      console.warn('Resend API key missing. Skipping email dispatch.');
      emailErrorMsg = 'Resend API key missing';
    }

    return res.status(200).json({
      success: true,
      order_number: order_number,
      db_status: dbSuccess ? 'saved' : `failed: ${dbErrorMsg}`,
      email_status: emailSuccess ? 'sent' : `failed: ${emailErrorMsg}`
    });

  } catch (error) {
    console.error('Error verifying payment:', error);
    return res.status(500).json({ error: error.message || 'Internal server error' });
  }
};
