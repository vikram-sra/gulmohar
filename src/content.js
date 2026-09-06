// Copy the 3D scene needs. The flat pages under public/work/ and public/about/
// are plain HTML and hold their own text -- one dummy work and an empty bio --
// rather than importing from here, because nothing in the scene reads them and
// a build-time indirection for two paragraphs would be the wrong trade.

export const SITE = {
    name: 'Gulmohar',
    tagline: 'An interactive botanical garden',
    instagram: 'https://www.instagram.com/gul.mo.harr/',
    email: ''
};
