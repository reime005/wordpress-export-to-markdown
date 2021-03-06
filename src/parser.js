const fs = require('fs');
const luxon = require('luxon');
const xml2js = require('xml2js');

const shared = require('./shared');
const settings = require('./settings');
const translator = require('./translator');

async function parseFilePromise(config) {
	console.log('\nParsing...');
	const content = await fs.promises.readFile(config.input, 'utf8');
	const data = await xml2js.parseStringPromise(content, {
		trim: true,
		tagNameProcessors: [xml2js.processors.stripPrefix]
	});

	const posts = collectPosts(data, config);

	const images = [];
	if (config.saveAttachedImages) {
		images.push(...collectAttachedImages(data));
	}
	if (config.saveScrapedImages) {
		images.push(...collectScrapedImages(data));
	}

	mergeImagesIntoPosts(images, posts);

	return posts;
}

function getItemsOfType(data, type) {
	return data.rss.channel[0].item.filter(item => item.post_type[0] === type);
}

function collectPosts(data, config) {
	// this is passed into getPostContent() for the markdown conversion
	const turndownService = translator.initTurndownService();

	const posts = getItemsOfType(data, 'post')
		.filter(post => post.status[0] !== 'trash' && post.status[0] !== 'draft')
		.map(post => ({
			// meta data isn't written to file, but is used to help with other things
			meta: {
				id: getPostId(post),
				slug: getPostSlug(post),
				coverImageId: getPostCoverImageId(post),
				imageUrls: []
			},
			frontmatter: {
				title: getPostTitle(post),
				date: getPostDate(post),
				description: "",
				slug: getPostSlug(post),
				categories: getCategories(post),
				tags: getTags(post)
			},
			content: translator.getPostContent(post, turndownService, config)
		}));

	console.log(posts.length + ' posts found.');
	return posts;
}

function getPostId(post) {
	return post.post_id[0];
}

function getPostSlug(post) {
	return decodeURI(post.post_name[0]);
}

function getPostCoverImageId(post) {
	if (post.postmeta === undefined) {
		return undefined;
	}

	const postmeta = post.postmeta.find(postmeta => postmeta.meta_key[0] === '_thumbnail_id');
	const id = postmeta ? postmeta.meta_value[0] : undefined;
	return id;
}

function getPostTitle(post) {
	return post.title[0];
}

function getPostDate(post) {
	const dateTime = luxon.DateTime.fromRFC2822(post.pubDate[0], { zone: 'utc' });

	if (settings.custom_date_formatting) {
		return dateTime.toFormat(settings.custom_date_formatting);
	} else if (settings.include_time_with_date) {
		return dateTime.toISO();
	} else {
		return dateTime.toISODate();
	}
}

function getCategories(post) {
	const categories = processCategoryTags(post, 'category');
	return categories.filter(category => !settings.filter_categories.includes(category));
}

function getTags(post) {
	return processCategoryTags(post, 'post_tag');
}

function processCategoryTags(post, domain) {
	if (!post.category) {
		return [];
	}

	return post.category
		.filter(category => category.$.domain === domain)
		.map(({ $: attributes }) => decodeURI(attributes.nicename));
}

function collectAttachedImages(data) {
	const images = getItemsOfType(data, 'attachment')
		// filter to certain image file types
		.filter(attachment => (/\.(gif|jpe?g|png)$/i).test(attachment.attachment_url[0]))
		.map(attachment => ({
			id: attachment.post_id[0],
			postId: attachment.post_parent[0],
			url: attachment.attachment_url[0]
		}));

	console.log(images.length + ' attached images found.');
	return images;
}

function collectScrapedImages(data) {
	const images = [];
	getItemsOfType(data, 'post').forEach(post => {
		const postId = post.post_id[0];
		const postContent = post.encoded[0];
		const postLink = post.link[0];

		const matches = [...postContent.matchAll(/<img[^>]*src="(.+?\.(?:gif|jpe?g|png))"[^>]*>/gi)];
		matches.forEach(match => {
			// base the matched image URL relative to the post URL
			const url = new URL(match[1], postLink).href;
			images.push({
				id: -1,
				postId: postId,
				url: decodeURI(url)
			});
		});
	});

	console.log(images.length + ' images scraped from post body content.');
	return images;
}

function mergeImagesIntoPosts(images, posts) {
	images.forEach(image => {
		posts.forEach(post => {
			let shouldAttach = false;

			// this image was uploaded as an attachment to this post
			if (image.postId === post.meta.id) {
				shouldAttach = true;
			}

			// this image was set as the featured image for this post
			if (image.id === post.meta.coverImageId) {
				shouldAttach = true;
				post.frontmatter.cover_image = `https://mariusreimer.com/images/${shared.getFilenameFromUrl(image.url)}`;
			}

			if (shouldAttach && !post.meta.imageUrls.includes(image.url)) {
				post.meta.imageUrls.push(image.url);
			}
		});
	});
}

exports.parseFilePromise = parseFilePromise;
