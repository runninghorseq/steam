const g2g = require('./g2g_api');

// Example usage of G2G API

/**
 * Example 1: Get services
 * @param {Object} options - Optional parameters (e.g., { language: 'en' })
 * @returns {Promise} The API response
 */
async function exampleGetServices(options = {}) {
    console.log('1. Getting services...');
    try {
        const services = await g2g.getServices(options);
        console.log('Success! Status:', services.statusCode);
        console.log('Data:', JSON.stringify(services.data, null, 2));
        return services;
    } catch (error) {
        console.error('Error getting services:', error.message);
        if (error.statusCode) {
            console.error('Status Code:', error.statusCode);
            console.error('Error Details:', JSON.stringify(error.error, null, 2));
        }
        throw error;
    }
}

/**
 * Example 2: Get brands for a service
 * @param {string} serviceId - The service ID
 * @returns {Promise} The API response
 */
async function exampleGetBrands(serviceId) {
    console.log(`2. Getting brands for service: ${serviceId}`);
    try {
        const brands = await g2g.getBrands(serviceId);
        console.log('Success! Status:', brands.statusCode);
        console.log('Data:', JSON.stringify(brands.data, null, 2));
        return brands;
    } catch (error) {
        console.error('Error getting brands:', error.message);
        if (error.statusCode) {
            console.error('Status Code:', error.statusCode);
            console.error('Error Details:', JSON.stringify(error.error, null, 2));
        }
        throw error;
    }
}

/**
 * Example 3: Get products
 * @param {Object} options - Product search options (e.g., { service_id, brand_id, category_id })
 * @returns {Promise} The API response
 */
async function exampleGetProducts(options = {}) {
    console.log('3. Getting products...');
    try {
        const products = await g2g.getProducts(options);
        console.log('Success! Status:', products.statusCode);
        console.log('Data:', JSON.stringify(products.data, null, 2));
        return products;
    } catch (error) {
        console.error('Error getting products:', error.message);
        if (error.statusCode) {
            console.error('Status Code:', error.statusCode);
            console.error('Error Details:', JSON.stringify(error.error, null, 2));
        }
        throw error;
    }
}

/**
 * Example 4: Get product attributes
 * @param {string} productId - The product ID
 * @returns {Promise} The API response
 */
async function exampleGetProductAttributes(productId) {
    console.log(`4. Getting attributes for product: ${productId}`);
    try {
        const attributes = await g2g.getProductAttributes(productId);
        console.log('Success! Status:', attributes.statusCode);
        console.log('Data:', JSON.stringify(attributes.data, null, 2));
        return attributes;
    } catch (error) {
        console.error('Error getting product attributes:', error.message);
        if (error.statusCode) {
            console.error('Status Code:', error.statusCode);
            console.error('Error Details:', JSON.stringify(error.error, null, 2));
        }
        throw error;
    }
}

/**
 * Example 5: Create an offer
 * @param {Object} offerData - The offer data object
 * @returns {Promise} The API response
 */
async function exampleCreateOffer(offerData) {
    console.log('5. Creating an offer...');
    try {
        const offer = await g2g.createOffer(offerData);
        console.log('Success! Status:', offer.statusCode);
        console.log('Data:', JSON.stringify(offer.data, null, 2));
        return offer;
    } catch (error) {
        console.error('Error creating offer:', error.message);
        if (error.statusCode) {
            console.error('Status Code:', error.statusCode);
            console.error('Error Details:', JSON.stringify(error.error, null, 2));
        }
        throw error;
    }
}

async function main() {
    try {
        console.log('=== G2G API Examples ===\n');
        
        // Example 1: Get services
        // await exampleGetServices();
        console.log('\n---\n');

        // Example 2: Get brands for a service
        const serviceId = '90015a0f-3983-4953-8368-96ac181d9e92';
        // await exampleGetBrands(serviceId);
        console.log('\n---\n');

        // Example 3: Get products
        // await exampleGetProducts({ service_id: serviceId, brand_id: 'lgc_game_19398' });
        console.log('\n---\n');

        // Example 4: Get product attributes
        const productId = '4422b0a0-c061-4116-9cba-7860a7ab752c';
        // await exampleGetProductAttributes(productId);
        // console.log('\n---\n');

        // Example 5: Create an offer
        // const offerData = {
        //     unit_price: 10,
        //     product_id: productId,
        //     min_qty: 1,
        //     api_qty: 1,
        //     low_stock_alert_qty: 1,
        //     currency: 'USD',
        //     title: 'Titan 94',
        //     offer_attributes: [
        //         {
        //             attribute_group_id: '72072d01',
        //             attribute_id: '4a159379'
        //         },
        //     ]
        // };

        const offerData = {
            api_qty: 1,
            product_id: productId,
            seller_id: "1001814582",
            qty: 10,
            description: "dddd",
            currency: "USD",
            min_qty: 1,
            low_stock_alert_qty: 0,
            sales_territory_settings: {
                settings_type: "global",
                countries: []
            },
            delivery_method_ids: ["13afdbb3-641a-419e-bce4-a4565233975f"],
            // delivery_speed_details: [{min: 1, max: 2147483647, delivery_time: 60}],
            delivery_speed: "instant",
            package_settings: [],
            title: "dddd",
            offer_attributes: [
                {
                    "collection_id": "ef6e5427",
                    "dataset_id": "4fc891eb"
                },
                {
                    "collection_id": "72072d01",
                    "dataset_id": "8f176e42"
                }
            ],
            unit_price: 39.82,
            other_pricing: [],
            region_id: "0f76ac42-3267-4d77-9fba-f9d9d719dac9",
            service_id: "90015a0f-3983-4953-8368-96ac181d9e92",
            brand_id: "lgc_game_19398",
            offer_type: "public"
        }
        await exampleCreateOffer(offerData);
        
    } catch (error) {
        console.error('Unexpected error:', error);
    }
}

// Run examples
if (require.main === module) {
    main();
}

module.exports = { 
    main,
    exampleGetServices,
    exampleGetBrands,
    exampleGetProducts,
    exampleGetProductAttributes,
    exampleCreateOffer
};

