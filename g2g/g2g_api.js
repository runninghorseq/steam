const https = require("https");
const CryptoJS = require("crypto-js");

const G2G_API_CONFIG = {
    baseUrl: "open-api.g2g.com",
    apiKey: "FVOVAYTQJ7FCF8TFENG0PGAVI0XNGFWI",
    secretKey: "AReRciZ65t9WzY1orDtXsPKTPR2Iicqj5l3OJuCavLn",
    userId: "1001814582",
    timestamp: "1653278884000"
};

function generateSignature(canonicalUrl, apiKey, userId, timestamp, secretKey) {
    console.log('canonicalUrl: ', canonicalUrl)
    console.log('apiKey: ', apiKey)
    console.log('userID: ', userId)
    console.log('timestamp: ', timestamp)
    console.log('secret: ', secretKey)
    const canonicalString = canonicalUrl + apiKey + userId + String(timestamp);
    const signature = CryptoJS.HmacSHA256(canonicalString, secretKey);
    return signature.toString(CryptoJS.enc.Hex);
}


function makeRequest(method, path, queryParams = {}, headers = {}, body = null) {
    return new Promise((resolve, reject) => {
        // Build query string
        const queryString = Object.keys(queryParams)
            .filter(k => queryParams[k] !== null && queryParams[k] !== undefined)
            .map(k => encodeURIComponent(k) + "=" + encodeURIComponent(queryParams[k]))
            .join("&");
        const fullPath = queryString ? path + "?" + queryString : path;
        
        // Generate timestamp and signature
        // Note: Signature must be calculated using the full path including query parameters
        const signature = generateSignature(path, G2G_API_CONFIG.apiKey, G2G_API_CONFIG.userId, G2G_API_CONFIG.timestamp, G2G_API_CONFIG.secretKey);
        console.log('signature: ', signature)
        console.log('fullpath: ', fullPath)
        // Set headers
        const defaultHeaders = Object.assign({
            "Content-Type": "application/json",
            "g2g-api-key": G2G_API_CONFIG.apiKey,
            "g2g-signature": signature,
            "g2g-timestamp": G2G_API_CONFIG.timestamp,
            "g2g-userid": G2G_API_CONFIG.userId
        }, headers);
        
        const options = {
            hostname: G2G_API_CONFIG.baseUrl,
            path: fullPath,
            method: method,
            headers: defaultHeaders
        };
        
        const req = https.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => {
                data += chunk;
            });
            res.on("end", () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve({
                            statusCode: res.statusCode,
                            data: json,
                            headers: res.headers
                        });
                    } else {
                        reject({
                            statusCode: res.statusCode,
                            error: json,
                            message: "API returned status " + res.statusCode
                        });
                    }
                } catch (e) {
                    reject({
                        statusCode: res.statusCode,
                        error: data,
                        message: "Failed to parse response"
                    });
                }
            });
        });
        
        req.on("error", (err) => {
            reject({
                error: err,
                message: "Request failed"
            });
        });
        
        // Send body for POST/PUT requests
        if (body && (method === "POST" || method === "PUT")) {
            const bodyString = typeof body === "string" ? body : JSON.stringify(body);
            req.write(bodyString);
        }
        
        req.end();
    });
}

async function getServices(options = {}) {
    const queryParams = {};
    if (options.language) {
        queryParams.language = options.language;
    }
    return makeRequest("GET", "/v2/services", queryParams);
}

async function getBrands(serviceId) {
    if (!serviceId) {
        throw new Error("serviceId is required");
    }
    return makeRequest("GET", "/v2/services/" + serviceId + "/brands");
}

async function getProducts(options = {}) {
    // Build path-based endpoint: /v2/products/{service_id}/brands
    if (options.service_id) {
        let path = `/v2/products`;
        const queryParams = {};
        if (options.service_id) queryParams.service_id = options.service_id;
        if (options.brand_id) queryParams.brand_id = options.brand_id;
        if (options.category_id) queryParams.category_id = options.category_id;
        return makeRequest("GET", path, queryParams);
    } else {
        // Fallback to query parameters if service_id is missing
        const queryParams = {};
        if (options.brand_id) queryParams.brand_id = options.brand_id;
        if (options.category_id) queryParams.category_id = options.category_id;
        return makeRequest("GET", "/v2/products", queryParams);
    }
}

async function getProductAttributes(productId) {
    if (!productId) {
        throw new Error("productId is required");
    }
    return makeRequest("GET", "/v2/products/" + productId + "/attributes");
}

async function createOffer(offerData) {
    if (!offerData) {
        throw new Error("offerData is required");
    }
    const requiredFields = ["unit_price", "product_id", "min_qty", "api_qty", "currency", "title"];
    for (const field of requiredFields) {
        if (!offerData[field]) {
            throw new Error(field + " is required in offerData");
        }
    }
    return makeRequest("POST", "/v2/offers", {}, {}, offerData);
}

module.exports = { getServices, getBrands, getProducts, getProductAttributes, createOffer, makeRequest, generateSignature, G2G_API_CONFIG };